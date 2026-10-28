import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { type INestApplication, Logger } from '@nestjs/common';
import { decodeJwt, SignJWT } from 'jose';
import { Client } from 'pg';

import { LOCAL_ISSUER, mintSession } from '../src/auth/local/local-session';
import { hashPassword } from '../src/auth/local/password';
import { OidcBrowser } from './support/oidc-browser';
import { type IdpAccount, type RealIdp, startRealIdp } from './support/oidc-idp';
import { THIS_SERVICE } from './support/service-process';
import {
  REDIRECT_URI,
  SSO_SECRET_KEY,
  bootSsoApp,
  clientAddress,
  from,
  newBinding,
  snapshotEnv,
} from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const PASSWORD = 'a-long-enough-passphrase';

const ACCOUNTS: Record<string, IdpAccount> = {
  'sub-ada': { email: 'Ada@Example.com', email_verified: true, name: 'Ada Lovelace' },
  'sub-bob': { email: 'bob@example.com', email_verified: true, name: 'Bob' },
  'sub-jit': { email: 'jit@other.org', email_verified: false },
  'sub-carol': { email: 'carol.sso@example.com', email_verified: true, name: 'Carol' },
  'sub-dup': { email: 'dup@example.com', email_verified: true },
  'sub-legacy': { email: 'legacy@example.com', email_verified: true },
  'sub-fail': { email: 'fail@example.com', email_verified: true },
  'sub-late': { email: 'late@example.com', email_verified: true },
  'sub-race': { email: 'race@example.com', email_verified: true },
  'sub-pkce': { email: 'pkce@example.com', email_verified: true },
  'sub-noemail': { name: 'No Email' },
  'sub-unverified': { email: 'unverified@example.com', email_verified: false },
  'sub-outsider': { email: 'out@elsewhere.net', email_verified: true },
  'sub-member': { email: 'member@example.com', email_verified: true },
  'sub-stranger': { email: 'stranger@example.com', email_verified: true },
  'sub-quiet': { email: 'quiet@other.org', email_verified: false },
  'sub-kim': { email: 'kim.sso@example.com', email_verified: true },
  'sub-left-open': { email: 'left.open@example.com', email_verified: true },
  'sub-mallory': { email: 'ceo@corp.example', email_verified: false },
  'sub-ceo': { email: 'ceo@corp.example', email_verified: true, name: 'The CEO' },
  'sub-mallory-too': { email: 'cfo@corp.example', email_verified: false },
  'sub-prober': { email: 'ada@example.com', email_verified: false },
  'sub-prober-too': { email: 'nobody.yet@corp.example', email_verified: false },
  'sub-early': { email: 'early@example.com', email_verified: true },
  'sub-clerk-person': { email: 'clerk.person@example.com', email_verified: true },
};

interface Started {
  binding: string;
  state: string;
  authorizeUrl: string;
  address: string;
}

/** Browser single sign-on end to end against oidc-provider, OpenID-certified, in its own process on loopback, its pages driven as a browser would. */
describe('single sign-on through a real OpenID provider (e2e, isolated DB)', () => {
  let idp: RealIdp;
  let app: INestApplication;
  let db: Client;
  let databaseUrl: string;
  let restoreEnv: () => void;
  let ownerToken = '';
  let ownerId = '';

  const ssoEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    ...extra,
  });

  async function reboot(env: Record<string, string>): Promise<void> {
    await app.close();
    app = await bootSsoApp(databaseUrl, env);
  }

  async function start(opts: { invite?: string; address?: string } = {}): Promise<Started> {
    const address = opts.address ?? clientAddress();
    const { binding, bindingHash } = newBinding();
    const res = await from(app, address)
      .post('/api/auth/oidc/start')
      .send({ binding_hash: bindingHash, ...(opts.invite ? { invite_token: opts.invite } : {}) })
      .expect(200);
    return {
      binding,
      state: res.body.state as string,
      authorizeUrl: res.body.authorize_url as string,
      address,
    };
  }

  async function authorize(
    flow: Started,
    login: string,
    browser = new OidcBrowser(),
  ): Promise<{ code: string; iss: string }> {
    const callback = await browser.authorize(flow.authorizeUrl, REDIRECT_URI, login);
    expect(callback.state).toBe(flow.state);
    expect(callback.code).toEqual(expect.any(String));
    return { code: callback.code!, iss: callback.iss! };
  }

  function complete(
    flow: Started,
    answer: { code: string; iss: string },
    path = '/api/auth/oidc/complete',
    token?: string,
  ) {
    const req = from(app, flow.address).post(path);
    if (token) void req.set('Authorization', `Bearer ${token}`);
    return req.send({ code: answer.code, state: flow.state, binding: flow.binding, iss: answer.iss });
  }

  async function signIn(login: string, opts: { invite?: string } = {}) {
    const flow = await start(opts);
    return complete(flow, await authorize(flow, login));
  }

  /** An authorization request straight to the provider, as another app on it would make. */
  async function directAuthorization(): Promise<{
    url: string;
    verifier: string;
    discovery: Record<string, string>;
  }> {
    const discovery = (await (
      await fetch(`${idp.issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, string>;
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(discovery.authorization_endpoint!);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email',
      state: 'direct',
      nonce: 'direct-nonce',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(k, v);
    }
    return { url: url.toString(), verifier, discovery };
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS rows`, params);
    return res.rows[0]!.n;
  }

  /** Run an operator CLI against this instance's database: its stdout when it succeeds, its stderr when it fails. */
  function runCli(
    script: string,
    args: string[],
    opts: { issuer?: string; input?: string } = {},
  ): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', `src/scripts/${script}`, ...args],
        {
          cwd: THIS_SERVICE,
          env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, OIDC_ISSUER: opts.issuer ?? idp.issuer },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('close', (code) => resolve({ code: code ?? 1, out: code === 0 ? stdout : stderr }));
      child.stdin.end(opts.input ?? '');
    });
  }

  const rowsCreated = async (): Promise<number[]> =>
    Promise.all(
      ['users', 'user_identities', 'org_members', 'organizations'].map((t) => count(`SELECT 1 FROM ${t}`)),
    );

  async function passwordAccount(email: string): Promise<string> {
    const id = randomUUID();
    const org = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, hashed_password, created_at, updated_at) VALUES ($1, $2, $2, $3, now(), now())`,
      [id, email, await hashPassword(PASSWORD)],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, $2, true, now(), now())`,
      [org, email],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [org, id],
    );
    return id;
  }

  async function invite(email: string, role = 'member'): Promise<{ orgId: string; token: string }> {
    const org = await from(app)
      .post('/api/orgs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: `Team ${randomBytes(3).toString('hex')}` })
      .expect(201);
    const orgId = org.body.id as string;
    const made = await from(app)
      .post(`/api/orgs/${orgId}/invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Org-Id', orgId)
      .send({ email, role })
      .expect(201);
    return { orgId, token: made.body.token as string };
  }

  beforeAll(async () => {
    restoreEnv = snapshotEnv();
    idp = await startRealIdp({ redirectUri: REDIRECT_URI, accounts: ACCOUNTS });
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    app = await bootSsoApp(databaseUrl, ssoEnv());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await idp?.stop();
    restoreEnv();
  });

  describe('accounts', () => {
    it('reports single sign-on, password sign-in off by default, and an instance awaiting its first account', async () => {
      const res = await from(app).get('/api/auth/local/status').expect(200);
      expect(res.body).toEqual({ enabled: false, awaiting_bootstrap: true, oidc: true });
    });

    it('creates the first account on the first sign-in — the owner of its own workspace — with a session that works at once', async () => {
      const res = await signIn('sub-ada');
      expect(res.status).toBe(200);
      ownerToken = res.body.token as string;
      ownerId = res.body.user.id as string;
      expect(decodeJwt(ownerToken)).toMatchObject({
        iss: LOCAL_ISSUER,
        sub: ownerId,
        method: 'oidc',
        idp: idp.issuer,
      });
      expect(res.body.joined_org_id).toBeUndefined();

      const me = await from(app).get('/api/auth/me').set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(me.body.user).toEqual({ id: ownerId, email: 'ada@example.com', name: 'Ada Lovelace' });
      expect(me.body.sign_in).toEqual({
        password: false,
        sso: { connected: true, email: 'ada@example.com' },
      });

      const user = await db.query(`SELECT hashed_password, clerk_user_id FROM users WHERE id = $1`, [
        ownerId,
      ]);
      expect(user.rows).toEqual([{ hashed_password: null, clerk_user_id: null }]);
      const identities = await db.query(
        `SELECT issuer, subject, email_at_link FROM user_identities WHERE user_id = $1`,
        [ownerId],
      );
      expect(identities.rows).toEqual([
        { issuer: idp.issuer, subject: 'sub-ada', email_at_link: 'ada@example.com' },
      ]);
      expect(await count(`SELECT 1 FROM user_settings WHERE user_id = $1`, [ownerId])).toBe(1);
      const memberships = await db.query(
        `SELECT o.is_personal, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1`,
        [ownerId],
      );
      expect(memberships.rows).toEqual([{ is_personal: true, role: 'owner' }]);
      const events = await db.query(
        `SELECT payload FROM domain_events WHERE type = 'user.provisioned' AND subject_id = $1`,
        [ownerId],
      );
      expect(events.rows).toEqual([{ payload: { method: 'oidc' } }]);

      const status = await from(app).get('/api/auth/local/status').expect(200);
      expect(status.body.awaiting_bootstrap).toBe(false);
    });

    it('gives anyone the provider vouches for an ordinary account of their own — and no org but their workspace', async () => {
      const before = await count(`SELECT 1 FROM org_members WHERE user_id = $1`, [ownerId]);
      const res = await signIn('sub-jit');
      expect(res.status).toBe(200);
      const jit = res.body.user.id as string;
      expect(res.body.user.email).toBe('jit@other.org');
      const memberships = await db.query(
        `SELECT o.is_personal, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1`,
        [jit],
      );
      expect(memberships.rows).toEqual([{ is_personal: true, role: 'owner' }]);
      expect(await count(`SELECT 1 FROM org_members WHERE user_id = $1`, [ownerId])).toBe(before);
    });

    it('signs a returning identity into the same account and creates nothing after the provider changes its email — which an account with no password then takes', async () => {
      idp.setAccounts({ ...ACCOUNTS, 'sub-ada': { email: 'ada.renamed@example.com', email_verified: true } });
      const before = await rowsCreated();
      try {
        const res = await signIn('sub-ada');
        expect(res.status).toBe(200);
        expect(res.body.user).toEqual({
          id: ownerId,
          email: 'ada.renamed@example.com',
          name: 'Ada Lovelace',
        });
      } finally {
        idp.setAccounts(ACCOUNTS);
      }
      expect(await rowsCreated()).toEqual(before);
      const seen = await db.query(`SELECT last_login_at FROM user_identities WHERE subject = 'sub-ada'`);
      expect(seen.rows[0].last_login_at).not.toBeNull();

      const back = await signIn('sub-ada');
      expect(back.body.user).toEqual({ id: ownerId, email: 'ada@example.com', name: 'Ada Lovelace' });
      expect(
        await count(`SELECT 1 FROM domain_events WHERE type = 'user.email_changed' AND subject_id = $1`, [
          ownerId,
        ]),
      ).toBe(2);
    });

    it('never links or adopts an account by its email: a match is refused and the account left as it was', async () => {
      const existing = await passwordAccount('dup@example.com');
      const before = await rowsCreated();
      const res = await signIn('sub-dup');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('oidc_account_exists');
      expect(await rowsCreated()).toEqual(before);
      const row = await db.query(
        `SELECT email, hashed_password IS NOT NULL AS has_password FROM users WHERE id = $1`,
        [existing],
      );
      expect(row.rows).toEqual([{ email: 'dup@example.com', has_password: true }]);
    });

    it('keeps an account’s address when its provider names one another account holds, or one it did not confirm', async () => {
      for (const changed of [
        { email: 'dup@example.com', email_verified: true },
        { email: 'ada.unconfirmed@example.com', email_verified: false },
      ]) {
        idp.setAccounts({ ...ACCOUNTS, 'sub-ada': changed });
        try {
          const res = await signIn('sub-ada');
          expect({ status: res.status, email: res.body.user?.email }).toEqual({
            status: 200,
            email: 'ada@example.com',
          });
        } finally {
          idp.setAccounts(ACCOUNTS);
        }
      }
      const held = await db.query(`SELECT email_verified FROM users WHERE lower(email) = 'dup@example.com'`);
      expect(held.rows).toEqual([{ email_verified: true }]);
    });

    it('refuses an identity with no email to make an account from, creating nothing', async () => {
      const before = await rowsCreated();
      const res = await signIn('sub-noemail');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('oidc_email_missing');
      expect(res.body.detail).toContain('email claim');
      expect(await rowsCreated()).toEqual(before);
    });
  });

  describe('invites', () => {
    it('lands a new invitee in the org, joined in the same transaction that made the account', async () => {
      const { orgId, token } = await invite('bob@example.com', 'admin');
      const res = await signIn('sub-bob', { invite: token });
      expect(res.status).toBe(200);
      expect(res.body.joined_org_id).toBe(orgId);
      const bob = res.body.user.id as string;
      const member = await db.query(`SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        bob,
      ]);
      expect(member.rows).toEqual([{ role: 'admin' }]);
      const used = await db.query(`SELECT accepted_by FROM org_invites WHERE token = $1`, [token]);
      expect(used.rows).toEqual([{ accepted_by: bob }]);
      expect(
        await count(`SELECT 1 FROM domain_events WHERE type = 'org.member_joined' AND org_id = $1`, [orgId]),
      ).toBe(1);
    });

    it('accepts an invite a returning identity signs in with', async () => {
      const { orgId, token } = await invite('ada@example.com');
      const res = await signIn('sub-ada', { invite: token });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(ownerId);
      expect(res.body.joined_org_id).toBe(orgId);
      expect(
        await count(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, ownerId]),
      ).toBe(1);
    });

    it('still makes the account when the invite is spent, and joins nothing', async () => {
      const { orgId, token } = await invite('late@example.com');
      await db.query(`UPDATE org_invites SET expires_at = now() - interval '1 minute' WHERE token = $1`, [
        token,
      ]);
      const res = await signIn('sub-late', { invite: token });
      expect(res.status).toBe(200);
      expect(res.body.joined_org_id).toBeUndefined();
      expect(
        await count(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [
          orgId,
          res.body.user.id,
        ]),
      ).toBe(0);
    });

    it('admits only the account at the address the invite was sent to — never one holding a forwarded link', async () => {
      const { orgId, token } = await invite('someone.else@example.com');
      const before = await rowsCreated();
      const stranger = await signIn('sub-stranger', { invite: token });
      expect({ status: stranger.status, code: stranger.body.code }).toEqual({
        status: 403,
        code: 'invite_email_mismatch',
      });
      expect(await rowsCreated()).toEqual(before);
      const returning = await signIn('sub-bob', { invite: token });
      expect({ status: returning.status, code: returning.body.code }).toEqual({
        status: 403,
        code: 'invite_email_mismatch',
      });
      expect(await count(`SELECT 1 FROM org_members WHERE org_id = $1`, [orgId])).toBe(1);
      const pending = await db.query(`SELECT accepted_by FROM org_invites WHERE token = $1`, [token]);
      expect(pending.rows).toEqual([{ accepted_by: null }]);
    });

    it('matches no invite to an address the provider did not confirm, until it confirms it', async () => {
      const quiet = await invite('quiet@other.org');
      const before = await rowsCreated();
      const unconfirmed = await signIn('sub-quiet', { invite: quiet.token });
      expect({ status: unconfirmed.status, code: unconfirmed.body.code }).toEqual({
        status: 403,
        code: 'invite_email_unverified',
      });
      expect(unconfirmed.body.detail).toContain('email_verified');
      expect(await rowsCreated()).toEqual(before);

      const { orgId, token } = await invite('jit@other.org');
      const returning = await signIn('sub-jit', { invite: token });
      expect({ status: returning.status, code: returning.body.code }).toEqual({
        status: 403,
        code: 'invite_email_unverified',
      });
      idp.setAccounts({ ...ACCOUNTS, 'sub-jit': { ...ACCOUNTS['sub-jit'], email_verified: true } });
      try {
        const confirmed = await signIn('sub-jit', { invite: token });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.joined_org_id).toBe(orgId);
      } finally {
        idp.setAccounts(ACCOUNTS);
      }
    });

    it('makes no account at all when joining the org fails', async () => {
      const { orgId, token } = await invite('fail@example.com');
      await db.query(`CREATE OR REPLACE FUNCTION e2e_refuse_join() RETURNS trigger LANGUAGE plpgsql AS $$
                      BEGIN RAISE EXCEPTION 'the join is refused by this test'; END $$`);
      await db.query(`CREATE TRIGGER e2e_refuse_join BEFORE INSERT ON org_members FOR EACH ROW
                      WHEN (NEW.org_id = '${orgId}'::uuid) EXECUTE FUNCTION e2e_refuse_join()`);
      try {
        const before = await rowsCreated();
        const res = await signIn('sub-fail', { invite: token });
        expect(res.status).toBe(500);
        expect(await rowsCreated()).toEqual(before);
        expect(await count(`SELECT 1 FROM users WHERE email = 'fail@example.com'`)).toBe(0);
      } finally {
        await db.query(`DROP TRIGGER e2e_refuse_join ON org_members`);
      }
    });
  });

  describe('an address its provider did not confirm, which holds and blocks nothing', () => {
    beforeAll(async () => {
      await reboot(ssoEnv({ LOCAL_AUTH_ENABLED: 'true' }));
    }, 30_000);

    afterAll(async () => {
      await reboot(ssoEnv());
    }, 30_000);

    async function holders(email: string): Promise<unknown[]> {
      const res = await db.query(
        `SELECT id, email_verified FROM users WHERE lower(email) = $1 ORDER BY email_verified`,
        [email],
      );
      return res.rows;
    }

    it('lets the person the provider confirms at an address take it after someone signed in with it unconfirmed, and their invite lands them', async () => {
      const mallory = await signIn('sub-mallory');
      expect(mallory.status).toBe(200);
      const { orgId, token } = await invite('ceo@corp.example', 'admin');
      const ceo = await signIn('sub-ceo', { invite: token });
      expect({ status: ceo.status, joined: ceo.body.joined_org_id }).toEqual({ status: 200, joined: orgId });
      const held = [
        { id: mallory.body.user.id, email_verified: false },
        { id: ceo.body.user.id, email_verified: true },
      ];
      expect(await holders('ceo@corp.example')).toEqual(held);

      idp.setAccounts({ ...ACCOUNTS, 'sub-mallory': { ...ACCOUNTS['sub-mallory'], email_verified: true } });
      try {
        const confirmedLater = await signIn('sub-mallory');
        expect({ status: confirmedLater.status, user: confirmedLater.body.user?.id }).toEqual({
          status: 200,
          user: mallory.body.user.id,
        });
      } finally {
        idp.setAccounts(ACCOUNTS);
      }
      expect(await holders('ceo@corp.example')).toEqual(held);
    });

    it('lets a password sign-up take an address someone signed in with unconfirmed, and its password reach that account', async () => {
      const mallory = await signIn('sub-mallory-too');
      expect(mallory.status).toBe(200);
      const { orgId, token } = await invite('cfo@corp.example');
      const registered = await from(app).post('/api/auth/local/register').send({
        email: 'CFO@corp.example',
        password: PASSWORD,
        name: '\u200bThe CFO\u202e',
        invite_token: token,
      });
      expect({
        status: registered.status,
        joined: registered.body.joined_org_id,
        name: registered.body.user?.name,
      }).toEqual({ status: 201, joined: orgId, name: 'The CFO' });
      const login = await from(app)
        .post('/api/auth/local/login')
        .send({ email: 'cfo@corp.example', password: PASSWORD });
      expect({ status: login.status, user: login.body.user?.id }).toEqual({
        status: 200,
        user: registered.body.user.id,
      });

      const reset = await runCli('set-password.cli.ts', ['CFO@corp.example'], {
        input: `${PASSWORD}-again\n${PASSWORD}-again\n`,
      });
      expect(reset).toEqual({
        code: 0,
        out: expect.stringContaining('Password updated for cfo@corp.example'),
      });
      const passwords = await db.query(
        `SELECT id, hashed_password IS NOT NULL AS has FROM users WHERE lower(email) = 'cfo@corp.example' ORDER BY 2`,
      );
      expect(passwords.rows).toEqual([
        { id: mallory.body.user.id, has: false },
        { id: registered.body.user.id, has: true },
      ]);
      await from(app)
        .post('/api/auth/local/login')
        .send({ email: 'cfo@corp.example', password: `${PASSWORD}-again` })
        .expect(200);
    }, 60_000);

    it('answers an unconfirmed address alike whether an account holds it or not, so signing in reveals no one’s account', async () => {
      const probes = [await signIn('sub-prober'), await signIn('sub-prober-too')];
      expect(probes.map((p) => [p.status, Object.keys(p.body).sort()])).toEqual([
        [200, ['expires_at', 'token', 'user']],
        [200, ['expires_at', 'token', 'user']],
      ]);
      expect(await holders('ada@example.com')).toEqual([
        { id: probes[0]!.body.user.id, email_verified: false },
        { id: ownerId, email_verified: true },
      ]);
      expect(await runCli('set-password.cli.ts', ['nobody.yet@corp.example'])).toEqual({
        code: 1,
        out: expect.stringContaining('never confirmed'),
      });
    }, 60_000);
  });

  describe('connecting single sign-on to a password account', () => {
    let carol = '';
    let carolSession = '';

    beforeAll(async () => {
      await reboot(ssoEnv({ LOCAL_AUTH_ENABLED: 'true' }));
      carol = await passwordAccount('carol@example.com');
      const login = await from(app)
        .post('/api/auth/local/login')
        .send({ email: 'carol@example.com', password: PASSWORD })
        .expect(200);
      carolSession = login.body.token as string;
    }, 30_000);

    async function linkStart(token: string, password?: string) {
      const flow = { ...newBinding(), address: clientAddress() };
      const res = await from(app, flow.address)
        .post('/api/auth/oidc/link/start')
        .set('Authorization', `Bearer ${token}`)
        .send({
          binding_hash: flow.bindingHash,
          ...(password === undefined ? {} : { current_password: password }),
        });
      return {
        res,
        flow: { ...flow, state: res.body.state as string, authorizeUrl: res.body.authorize_url as string },
      };
    }

    it('asks for the password first, and a wrong one is refused', async () => {
      const wrong = await linkStart(carolSession, 'not-the-password');
      expect(wrong.res.status).toBe(401);
      expect(wrong.res.body.code).toBe('invalid_credentials');
      const none = await linkStart(carolSession);
      expect(none.res.status).toBe(401);
    });

    it('is a signed-in person’s act, never an API key’s', async () => {
      const key = await from(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${carolSession}`)
        .send({ name: 'ci', scopes: ['workflow:read'] })
        .expect(201);
      const res = await linkStart(key.body.key as string, PASSWORD);
      expect(res.res.status).toBe(403);
      expect(res.res.body.detail).toContain('Use a signed-in session');
    });

    it('connects the identity, and the next single sign-on lands in the same account', async () => {
      const { res, flow } = await linkStart(carolSession, PASSWORD);
      expect(res.status).toBe(200);
      const answer = await authorize({ ...flow, binding: flow.binding }, 'sub-carol');
      const linked = await complete(
        { ...flow, binding: flow.binding },
        answer,
        '/api/auth/oidc/link/complete',
        carolSession,
      );
      expect(linked.status).toBe(200);
      expect(linked.body).toEqual({ connected: true, email: 'carol.sso@example.com' });
      expect(
        await count(`SELECT 1 FROM domain_events WHERE type = 'user.identity_linked' AND subject_id = $1`, [
          carol,
        ]),
      ).toBe(1);

      const sso = await signIn('sub-carol');
      expect(sso.status).toBe(200);
      expect(sso.body.user).toMatchObject({ id: carol, email: 'carol@example.com' });
      const me = await from(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${carolSession}`)
        .expect(200);
      expect(me.body.sign_in).toEqual({
        password: true,
        sso: { connected: true, email: 'carol.sso@example.com' },
      });
    });

    it('makes the person sign in at the provider again, so a provider session someone left open in the browser is never the one connected', async () => {
      const kim = await passwordAccount('kim@example.com');
      const kimSession = (await mintSession(kim, SSO_SECRET_KEY)).token;
      const browser = new OidcBrowser();
      const leftOpen = await browser.authorize(
        (await directAuthorization()).url,
        REDIRECT_URI,
        'sub-left-open',
      );
      expect(leftOpen.code).toEqual(expect.any(String));

      const { res, flow } = await linkStart(kimSession, PASSWORD);
      expect(res.status).toBe(200);
      const answer = await authorize({ ...flow, binding: flow.binding }, 'sub-kim', browser);
      const linked = await complete(
        { ...flow, binding: flow.binding },
        answer,
        '/api/auth/oidc/link/complete',
        kimSession,
      );
      expect(linked.body).toEqual({ connected: true, email: 'kim.sso@example.com' });
      const identities = await db.query(`SELECT subject FROM user_identities WHERE user_id = $1`, [kim]);
      expect(identities.rows).toEqual([{ subject: 'sub-kim' }]);
      expect(await count(`SELECT 1 FROM user_identities WHERE subject = 'sub-left-open'`)).toBe(0);
    });

    it('refuses a second identity for the same account, and an identity another account holds', async () => {
      const again = await linkStart(carolSession, PASSWORD);
      expect(again.res.status).toBe(409);
      expect(again.res.body.code).toBe('oidc_already_linked');

      const other = await passwordAccount('other@example.com');
      const otherSession = (await mintSession(other, SSO_SECRET_KEY)).token;
      const { flow } = await linkStart(otherSession, PASSWORD);
      const answer = await authorize({ ...flow, binding: flow.binding }, 'sub-carol');
      const taken = await complete(
        { ...flow, binding: flow.binding },
        answer,
        '/api/auth/oidc/link/complete',
        otherSession,
      );
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('oidc_identity_in_use');
      expect(await count(`SELECT 1 FROM user_identities WHERE user_id = $1`, [other])).toBe(0);
    });

    it('disconnects while the account keeps its password, and never leaves an account with no way in', async () => {
      await from(app)
        .delete('/api/auth/oidc/link')
        .set('Authorization', `Bearer ${carolSession}`)
        .expect(204);
      const twice = await from(app)
        .delete('/api/auth/oidc/link')
        .set('Authorization', `Bearer ${carolSession}`)
        .expect(404);
      expect(twice.body.code).toBe('oidc_not_linked');
      const me = await from(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${carolSession}`)
        .expect(200);
      expect(me.body.sign_in.sso).toEqual({ connected: false, email: null });

      const ssoOnly = await from(app)
        .delete('/api/auth/oidc/link')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(409);
      expect(ssoOnly.body.code).toBe('oidc_last_sign_in_method');
      expect(await count(`SELECT 1 FROM user_identities WHERE user_id = $1`, [ownerId])).toBe(1);
    });

    it('keeps single sign-on connected while password sign-in is off, though the account has a password', async () => {
      await db.query(
        `INSERT INTO user_identities (id, user_id, issuer, subject, email_at_link) VALUES ($1, $2, $3, 'sub-carol', NULL)`,
        [randomUUID(), carol, idp.issuer],
      );
      await reboot(ssoEnv());
      try {
        const ssoSession = (await mintSession(carol, SSO_SECRET_KEY, { method: 'oidc', idp: idp.issuer }))
          .token;
        const refusedUnlink = await from(app)
          .delete('/api/auth/oidc/link')
          .set('Authorization', `Bearer ${ssoSession}`)
          .expect(409);
        expect(refusedUnlink.body.code).toBe('oidc_last_sign_in_method');
        expect(await count(`SELECT 1 FROM user_identities WHERE user_id = $1`, [carol])).toBe(1);
      } finally {
        await reboot(ssoEnv({ LOCAL_AUTH_ENABLED: 'true' }));
      }
    }, 60_000);
  });

  describe('which sessions each configuration accepts', () => {
    let passwordSession = '';
    let ssoSession = '';
    let claimless = '';
    const me = (token: string) => from(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
      passwordSession = (await mintSession(ownerId, SSO_SECRET_KEY)).token;
      ssoSession = (await mintSession(ownerId, SSO_SECRET_KEY, { method: 'oidc', idp: idp.issuer })).token;
      claimless = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(LOCAL_ISSUER)
        .setSubject(ownerId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(SSO_SECRET_KEY));
    });

    it('takes both while LOCAL_AUTH_ENABLED=true keeps passwords beside single sign-on', async () => {
      await reboot(ssoEnv({ LOCAL_AUTH_ENABLED: 'true' }));
      await me(passwordSession).expect(200);
      await me(ssoSession).expect(200);
    }, 30_000);

    it('signs password sessions out once single sign-on turns passwords off, and keeps single sign-on ones', async () => {
      await reboot(ssoEnv());
      expect((await me(passwordSession).expect(401)).body.code).toBe('token_rejected');
      await me(claimless).expect(401);
      await me(ssoSession).expect(200);
      const login = await from(app)
        .post('/api/auth/local/login')
        .send({ email: 'carol@example.com', password: PASSWORD })
        .expect(404);
      expect(login.body.code).toBe('local_auth_disabled');
    }, 30_000);

    it('refuses single sign-on sessions once OIDC_ISSUER names another issuer — a trailing slash apart is another', async () => {
      await reboot(ssoEnv({ OIDC_ISSUER: `${idp.issuer}/` }));
      await me(ssoSession).expect(401);
    }, 30_000);

    it('refuses them once single sign-on is off, and reads a token from before methods as a password session', async () => {
      await reboot({});
      await me(ssoSession).expect(401);
      await me(passwordSession).expect(200);
      await me(claimless).expect(200);
    }, 30_000);

    it('with an issuer alone and passwords off: no sign-in door is open and even a well-signed session is refused', async () => {
      await reboot({ OIDC_ISSUER: idp.issuer, LOCAL_AUTH_ENABLED: 'false' });
      const started = await from(app)
        .post('/api/auth/oidc/start')
        .send({ binding_hash: newBinding().bindingHash })
        .expect(404);
      expect(started.body.code).toBe('oidc_disabled');
      const completed = await from(app)
        .post('/api/auth/oidc/complete')
        .send({ code: 'c', state: 's', binding: newBinding().binding })
        .expect(404);
      expect(completed.body.code).toBe('oidc_disabled');
      await me(claimless).expect(401);
      await me(ssoSession).expect(401);
    }, 30_000);

    afterAll(async () => {
      await reboot(ssoEnv());
    }, 30_000);
  });

  describe('what only a real provider refuses', () => {
    it('spends a state once: of two completions racing for it, exactly one signs in', async () => {
      const flow = await start();
      const answer = await authorize(flow, 'sub-race');
      const side = new Client({ connectionString: databaseUrl });
      await side.connect();
      try {
        await side.query('BEGIN');
        await side.query('LOCK TABLE oidc_login_states IN ACCESS EXCLUSIVE MODE');
        const racing = [complete(flow, answer).then((r) => r), complete(flow, answer).then((r) => r)];
        for (let i = 0; i < 200; i++) {
          const waiting = await side.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
              WHERE c.relname = 'oidc_login_states' AND NOT l.granted
                AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          );
          if (waiting.rows[0]!.n === 2) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        const parked = await side.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE c.relname = 'oidc_login_states' AND NOT l.granted`,
        );
        expect(parked.rows[0]!.n).toBe(2);
        await side.query('COMMIT');
        const results = await Promise.all(racing);
        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
        expect(results.find((r) => r.status === 400)!.body.code).toBe('oidc_state_invalid');
      } finally {
        await side.end();
      }
      expect(await count(`SELECT 1 FROM user_identities WHERE subject = 'sub-race'`)).toBe(1);
    });

    it('binds a code to the flow that asked for it (PKCE), and a spent code never redeems twice', async () => {
      const a = await start();
      const b = await start();
      const answerA = await authorize(a, 'sub-pkce');
      const crossed = await complete(b, answerA);
      expect(crossed.status).toBe(401);
      expect(crossed.body.code).toBe('oidc_token_rejected');

      const own = await complete(a, answerA);
      expect(own.status).toBe(200);
      const c = await start();
      const replayed = await complete(c, answerA);
      expect(replayed.status).toBe(401);
      expect(replayed.body.code).toBe('oidc_token_rejected');
    });

    it('takes no identity-provider token as an API bearer: the retired door answers 401 and creates nothing', async () => {
      const { url, verifier, discovery } = await directAuthorization();
      const callback = await new OidcBrowser().authorize(url, REDIRECT_URI, 'sub-member');
      const basic = Buffer.from(
        `${encodeURIComponent(idp.clientId)}:${encodeURIComponent(idp.clientSecret)}`,
      ).toString('base64');
      const tokens = (await (
        await fetch(discovery.token_endpoint!, {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: callback.code!,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          }),
        })
      ).json()) as { id_token?: string };
      expect(decodeJwt(tokens.id_token!)).toMatchObject({ iss: idp.issuer, sub: 'sub-member' });

      // Everything the retired door once read, pointed at this provider's real keys.
      await reboot(ssoEnv({ OIDC_JWKS_URL: discovery.jwks_uri!, OIDC_AUDIENCE: idp.clientId }));
      const before = await rowsCreated();
      const res = await from(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.id_token!}`)
        .expect(401);
      expect(res.body.code).toBe('token_rejected');
      expect(await rowsCreated()).toEqual(before);
    });

    it('limits sign-in starts to 20 a minute from one address', async () => {
      const address = clientAddress();
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = await from(app, address)
          .post('/api/auth/oidc/start')
          .send({ binding_hash: newBinding().bindingHash });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([...Array<number>(20).fill(200), 429]);
    });
  });

  describe('OIDC_ALLOWED_DOMAINS', () => {
    beforeAll(async () => {
      await reboot(ssoEnv({ OIDC_ALLOWED_DOMAINS: 'example.com' }));
    }, 30_000);

    afterAll(async () => {
      await reboot(ssoEnv());
    }, 30_000);

    it('admits a verified address at a listed domain', async () => {
      const res = await signIn('sub-member');
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('member@example.com');
    });

    it('refuses an address the provider did not verify, naming the claim, and one at another domain', async () => {
      const before = await rowsCreated();
      const unverified = await signIn('sub-unverified');
      expect(unverified.status).toBe(403);
      expect(unverified.body.code).toBe('oidc_email_unverified');
      expect(unverified.body.detail).toContain('email_verified');
      const outsider = await signIn('sub-outsider');
      expect(outsider.status).toBe(403);
      expect(outsider.body.code).toBe('oidc_domain_not_allowed');
      expect(await rowsCreated()).toEqual(before);
    });

    it('holds a returning identity to the rule too', async () => {
      const res = await signIn('sub-jit');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('oidc_email_unverified');
    });
  });

  describe('pnpm auth:link-sso — connecting accounts made before single sign-on', () => {
    const run = (args: string[], issuer = idp.issuer) => runCli('link-sso.cli.ts', args, { issuer });
    const CLERK_ID = 'user_2NNEqL2nrIRdJ194ndJqAHwEfxC';

    async function account(
      email: string,
      clerkUserId: string | null,
      verified = true,
      id = randomUUID(),
    ): Promise<string> {
      await db.query(
        `INSERT INTO users (id, email, name, clerk_user_id, email_verified, created_at, updated_at)
         VALUES ($1, $2, 'Before', $3, $4, now(), now())`,
        [id, email, clerkUserId, verified],
      );
      return id;
    }

    async function subjectsOf(userId: string): Promise<unknown[]> {
      const res = await db.query(`SELECT subject FROM user_identities WHERE user_id = $1 AND issuer = $2`, [
        userId,
        idp.issuer,
      ]);
      return res.rows;
    }

    it('links the account to its subject, and its next single sign-on lands there', async () => {
      const legacy = await account('legacy@example.com', 'sub-legacy');
      const linked = await run(['Legacy@Example.com', 'sub-legacy']);
      expect(linked).toEqual({
        code: 0,
        out: expect.stringContaining('Linked legacy@example.com to sub-legacy'),
      });
      const again = await run(['legacy@example.com', 'sub-legacy']);
      expect(again).toEqual({ code: 0, out: expect.stringContaining('already signs in as sub-legacy') });

      const res = await signIn('sub-legacy');
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(legacy);
    }, 60_000);

    it('refuses an unknown email, a subject another account holds, and a run without OIDC_ISSUER', async () => {
      expect(await run(['nobody@example.com', 'sub-x'])).toEqual({
        code: 1,
        out: expect.stringContaining('No account'),
      });
      expect(await run(['dup@example.com', 'sub-ada'])).toEqual({
        code: 1,
        out: expect.stringMatching(/already signs in to another account .*--move/s),
      });
      expect(await run(['legacy@example.com', 'sub-legacy-elsewhere'])).toEqual({
        code: 1,
        out: expect.stringContaining('already connected to a different subject'),
      });
      expect(await run(['dup@example.com', 'sub-x'], '')).toEqual({
        code: 1,
        out: expect.stringContaining('OIDC_ISSUER is not set'),
      });
      expect(await count(`SELECT 1 FROM user_identities WHERE subject = 'sub-x'`)).toBe(0);
    }, 60_000);

    it('lists the accounts not yet connected that hold a subject from before, and connects one to the subject the retired token sign-in stored', async () => {
      const token = await account('sub-oldtoken@oidc.local', 'sub-oldtoken');
      const clerk = await account('clerk.person@example.com', CLERK_ID);
      const listed = await run(['--list']);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain(
        `${token}\tsub-oldtoken@oidc.local\tsub-oldtoken (the retired token sign-in)`,
      );
      expect(listed.out).toContain(`${clerk}\tclerk.person@example.com\t${CLERK_ID} (Clerk)`);
      expect(listed.out).not.toContain('legacy@example.com');

      expect(await run(['sub-oldtoken@oidc.local'])).toEqual({
        code: 0,
        out: expect.stringContaining('Linked sub-oldtoken@oidc.local to sub-oldtoken'),
      });
      expect(await subjectsOf(token)).toEqual([{ subject: 'sub-oldtoken' }]);
      expect(await run([clerk])).toEqual({ code: 1, out: expect.stringContaining('issued by Clerk') });
      expect(await subjectsOf(clerk)).toEqual([]);
    }, 60_000);

    it('connects every account the retired token sign-in made with --all, leaving Clerk’s for a subject of its own', async () => {
      const a = await account('sub-all-a@oidc.local', 'sub-all-a');
      const b = await account('all.b@example.com', 'sub-all-b');
      const all = await run(['--all']);
      expect(all.code).toBe(0);
      expect(all.out).toContain('Linked sub-all-a@oidc.local to sub-all-a');
      expect(all.out).toContain('Linked all.b@example.com to sub-all-b');
      expect(all.out).toContain('Skipped clerk.person@example.com');
      expect([await subjectsOf(a), await subjectsOf(b)]).toEqual([
        [{ subject: 'sub-all-a' }],
        [{ subject: 'sub-all-b' }],
      ]);
      expect(await count(`SELECT 1 FROM user_identities WHERE subject = $1`, [CLERK_ID])).toBe(0);
      expect((await run(['--list'])).out).not.toContain('sub-all-a');
    }, 60_000);

    it('moves an identity a first sign-in gave a new account with --move: the old account then signs in and takes its address, which the new one gives up', async () => {
      const old = await account('sub-early@oidc.local', 'sub-early');
      const early = await signIn('sub-early');
      expect(early.status).toBe(200);
      const made = early.body.user.id as string;
      expect(made).not.toBe(old);

      expect(await run(['sub-early@oidc.local'])).toEqual({
        code: 1,
        out: expect.stringContaining('--move'),
      });
      expect(await run(['sub-early@oidc.local', '--move'])).toEqual({
        code: 0,
        out: expect.stringContaining(`Moved sub-early at ${idp.issuer} from early@example.com`),
      });
      expect([await subjectsOf(old), await subjectsOf(made)]).toEqual([[{ subject: 'sub-early' }], []]);

      const back = await signIn('sub-early');
      expect(back.body.user).toMatchObject({ id: old, email: 'early@example.com' });
      const held = await db.query(
        `SELECT id, email_verified FROM users WHERE lower(email) = 'early@example.com' ORDER BY email_verified`,
      );
      expect(held.rows).toEqual([
        { id: made, email_verified: false },
        { id: old, email_verified: true },
      ]);
    }, 60_000);

    it('takes the account that holds an address over one using it unconfirmed in other letter case, and an account by its id', async () => {
      const suffix = randomBytes(6).toString('hex');
      const loose = await account(
        'Case.Person@example.com',
        null,
        false,
        `00000000-0000-4000-8000-${suffix}`,
      );
      const holder = await account(
        'case.person@example.com',
        null,
        true,
        `ffffffff-0000-4000-8000-${suffix}`,
      );
      expect(await run(['CASE.person@example.com', 'sub-case'])).toEqual({
        code: 0,
        out: expect.stringContaining('Linked case.person@example.com to sub-case'),
      });
      expect([await subjectsOf(holder), await subjectsOf(loose)]).toEqual([[{ subject: 'sub-case' }], []]);
      expect(await run([loose, 'sub-case-loose'])).toEqual({
        code: 0,
        out: expect.stringContaining('Linked Case.Person@example.com to sub-case-loose'),
      });
      expect(await subjectsOf(loose)).toEqual([{ subject: 'sub-case-loose' }]);
    }, 60_000);

    it('warns at boot while an account from before single sign-on is not connected to it, naming the CLI', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        await reboot(ssoEnv());
        expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
          expect.stringMatching(
            /^1 account from before single sign-on is not connected to it .*sarati-link-sso --list/,
          ),
        );
      } finally {
        warn.mockRestore();
      }
    }, 60_000);

    it('reaches a Clerk-made account only once an operator connects it, never by its email', async () => {
      const clerk = await db.query<{ id: string }>(`SELECT id FROM users WHERE clerk_user_id = $1`, [
        CLERK_ID,
      ]);
      const before = await rowsCreated();
      const early = await signIn('sub-clerk-person');
      expect({ status: early.status, code: early.body.code }).toEqual({
        status: 409,
        code: 'oidc_account_exists',
      });
      expect(await rowsCreated()).toEqual(before);

      expect(await run(['clerk.person@example.com', 'sub-clerk-person'])).toEqual({
        code: 0,
        out: expect.stringContaining('Linked clerk.person@example.com to sub-clerk-person'),
      });
      const connected = await signIn('sub-clerk-person');
      expect({ status: connected.status, user: connected.body.user?.id }).toEqual({
        status: 200,
        user: clerk.rows[0]!.id,
      });
    }, 60_000);
  });
});
