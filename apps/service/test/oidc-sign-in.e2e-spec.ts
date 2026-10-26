import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
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

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS rows`, params);
    return res.rows[0]!.n;
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

    it('signs a returning identity into the same account and creates nothing, even after the provider changes its email', async () => {
      idp.setAccounts({ ...ACCOUNTS, 'sub-ada': { email: 'ada.renamed@example.com', email_verified: true } });
      const before = await rowsCreated();
      try {
        const res = await signIn('sub-ada');
        expect(res.status).toBe(200);
        expect(res.body.user).toEqual({ id: ownerId, email: 'ada@example.com', name: 'Ada Lovelace' });
      } finally {
        idp.setAccounts(ACCOUNTS);
      }
      expect(await rowsCreated()).toEqual(before);
      const seen = await db.query(`SELECT last_login_at FROM user_identities WHERE subject = 'sub-ada'`);
      expect(seen.rows[0].last_login_at).not.toBeNull();
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
      expect(sso.body.user.id).toBe(carol);
      const me = await from(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${carolSession}`)
        .expect(200);
      expect(me.body.sign_in).toEqual({
        password: true,
        sso: { connected: true, email: 'carol.sso@example.com' },
      });
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
      const callback = await new OidcBrowser().authorize(url.toString(), REDIRECT_URI, 'sub-member');
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

  describe('pnpm auth:link-sso — for accounts the retired bearer door created', () => {
    const run = (args: string[], issuer = idp.issuer) =>
      promisify(execFile)(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', 'src/scripts/link-sso.cli.ts', ...args],
        {
          cwd: THIS_SERVICE,
          env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, OIDC_ISSUER: issuer },
        },
      ).then(
        ({ stdout }) => ({ code: 0, out: stdout }),
        (err: { code: number; stderr: string }) => ({ code: err.code, out: err.stderr }),
      );

    it('links the account to its subject, and its next single sign-on lands there', async () => {
      const legacy = randomUUID();
      await db.query(
        `INSERT INTO users (id, email, name, clerk_user_id, created_at, updated_at)
         VALUES ($1, 'legacy@example.com', 'Legacy', 'sub-legacy', now(), now())`,
        [legacy],
      );
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
        out: expect.stringContaining('already signs in to another account'),
      });
      expect(await run(['dup@example.com', 'sub-x'], '')).toEqual({
        code: 1,
        out: expect.stringContaining('OIDC_ISSUER is not set'),
      });
      expect(await count(`SELECT 1 FROM user_identities WHERE subject = 'sub-x'`)).toBe(0);
    }, 60_000);
  });
});
