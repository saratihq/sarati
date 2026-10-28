import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import type request from 'supertest';

import { mintSession } from '../src/auth/local/local-session';
import { ADMISSION_LOCK_SPACE } from '../src/database/advisory-lock-spaces';
import { HostileIdp } from './support/hostile-idp';
import { lockProbes, pause } from './support/lock-probes';
import { insertPersonalOrgs } from './support/personal-org';
import { THIS_SERVICE } from './support/service-process';
import { SSO_SECRET_KEY, bootSsoApp, clientAddress, from, newBinding, snapshotEnv } from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const PASSWORD = 'a-long-enough-passphrase';

/** Admission takes turns on one advisory lock; each race is made deterministic by holding it from a side connection until every contender waits. */
describe('account admission takes turns (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let side: Client;
  let databaseUrl = '';
  let restoreEnv: () => void;
  const idp = new HostileIdp();
  const { lockWaiters, gateEmits, deadlocks, deadlocksSince } = lockProbes(
    () => app,
    () => db,
  );
  const ssoEnv = (): Record<string, string> => ({
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
  });

  interface SsoFlow {
    address: string;
    binding: string;
    state: string;
    nonce: string;
  }

  async function startSso(
    path = '/api/auth/oidc/start',
    extra: Record<string, string> = {},
    session?: string,
  ) {
    const address = clientAddress();
    const { binding, bindingHash } = newBinding();
    const req = from(app, address).post(path);
    if (session) void req.set('Authorization', `Bearer ${session}`);
    const res = await req.send({ binding_hash: bindingHash, ...extra }).expect(200);
    const nonce = new URL(res.body.authorize_url as string).searchParams.get('nonce')!;
    return { address, binding, state: res.body.state as string, nonce } satisfies SsoFlow;
  }

  /** Answer every code exchange for `flow` with an ID token for `sub` at `email`, the code naming which flow it answers. */
  function answerFlows(flows: Array<{ code: string; flow: SsoFlow; sub: string; email: string }>): void {
    idp.token = async (req) => {
      const code = new URLSearchParams(req.body).get('code');
      const { flow, sub, email } = flows.find((f) => f.code === code)!;
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: idp.issuer,
        aud: idp.clientId,
        sub,
        nonce: flow.nonce,
        iat: now,
        exp: now + 300,
        auth_time: now,
      };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: await idp.sign({ ...claims, email, email_verified: true }) }),
      };
    };
  }

  const completeSso = (flow: SsoFlow, code: string, path = '/api/auth/oidc/complete', session?: string) => {
    const req = from(app, flow.address).post(path);
    if (session) void req.set('Authorization', `Bearer ${session}`);
    return req.send({ code, state: flow.state, binding: flow.binding, iss: idp.issuer });
  };

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS r`, params);
    return rows[0]!.n;
  }

  async function waitersOnAdmission(count: number, tries = 200): Promise<void> {
    for (let i = 0; i < tries; i++) {
      const { rows } = await side.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objid = 0 AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [ADMISSION_LOCK_SPACE],
      );
      if (rows[0]!.n === count) return;
      await pause(25);
    }
    throw new Error(`never saw ${count} admissions wait on the lock`);
  }

  /** Fire `requests` while the side connection holds the admission lock, release it once all of them wait, and settle. */
  async function race(requests: Array<() => request.Test>): Promise<request.Response[]> {
    await side.query('SELECT pg_advisory_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
    const settled = requests.map((send) => send().then((res) => res));
    try {
      await waitersOnAdmission(requests.length);
    } finally {
      await side.query('SELECT pg_advisory_unlock($1, 0)', [ADMISSION_LOCK_SPACE]);
    }
    return Promise.all(settled);
  }

  interface Invited {
    orgId: string;
    inviteId: string;
    token: string;
  }

  /** The owner's org and an invite to it for `email`, on an instance whose first account the owner already is. */
  async function inviteFrom(owner: string, email: string): Promise<Invited> {
    const org = await from(app)
      .post('/api/orgs')
      .set('Authorization', `Bearer ${owner}`)
      .send({ name: 'Team' });
    const orgId = org.body.id as string;
    const made = await from(app)
      .post(`/api/orgs/${orgId}/invites`)
      .set('Authorization', `Bearer ${owner}`)
      .set('X-Org-Id', orgId)
      .send({ email })
      .expect(201);
    return { orgId, inviteId: made.body.id as string, token: made.body.token as string };
  }

  /** Run `sarati-link-sso` against this instance, settling with its exit code and what it printed. */
  const linkSso = (...args: string[]): Promise<{ code: number; out: string }> =>
    promisify(execFile)(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', 'src/scripts/link-sso.cli.ts', ...args],
      {
        cwd: THIS_SERVICE,
        env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, OIDC_ISSUER: idp.issuer },
      },
    ).then(
      ({ stdout }) => ({ code: 0, out: stdout }),
      (err: { code: number; stderr: string }) => ({ code: err.code, out: err.stderr }),
    );

  async function freshInstance(env: Record<string, string>): Promise<void> {
    await app?.close();
    await db?.end();
    await side?.end();
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    side = new Client({ connectionString: databaseUrl });
    await db.connect();
    await side.connect();
    app = await bootSsoApp(databaseUrl, env);
  }

  beforeAll(async () => {
    restoreEnv = snapshotEnv();
    await idp.start();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await side?.end();
    await idp.stop();
    restoreEnv();
  });

  it('lets exactly one of two first-run registrations become the first account', async () => {
    await freshInstance({});
    const register = (email: string) => () =>
      from(app).post('/api/auth/local/register').send({ email, password: PASSWORD });

    const results = await race([register('first@example.com'), register('second@example.com')]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(results.find((r) => r.status === 403)!.body.code).toBe('signup_closed');
    const users = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    expect(users.rows[0]!.n).toBe(1);
  }, 60_000);

  it('signs one identity racing itself from two tabs into one account', async () => {
    await freshInstance({
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      OIDC_CLIENT_SECRET: idp.clientSecret,
    });
    const flows = await Promise.all(
      ['code-a', 'code-b'].map(async (code) => {
        const address = clientAddress();
        const { binding, bindingHash } = newBinding();
        const res = await from(app, address)
          .post('/api/auth/oidc/start')
          .send({ binding_hash: bindingHash })
          .expect(200);
        const nonce = new URL(res.body.authorize_url as string).searchParams.get('nonce')!;
        return { code, address, binding, state: res.body.state as string, nonce };
      }),
    );
    const now = Math.floor(Date.now() / 1000);
    idp.token = async (req) => {
      const code = new URLSearchParams(req.body).get('code');
      const flow = flows.find((f) => f.code === code)!;
      const claims = {
        iss: idp.issuer,
        aud: idp.clientId,
        sub: 'the-same-person',
        nonce: flow.nonce,
        iat: now,
        exp: now + 300,
        email: 'twice@example.com',
      };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: await idp.sign(claims) }),
      };
    };

    const results = await race(
      flows.map(
        (flow) => () =>
          from(app, flow.address)
            .post('/api/auth/oidc/complete')
            .send({ code: flow.code, state: flow.state, binding: flow.binding, iss: idp.issuer }),
      ),
    );

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.body.user.id).toBe(results[1]!.body.user.id);
    const identities = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_identities`);
    const users = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    expect([identities.rows[0]!.n, users.rows[0]!.n]).toEqual([1, 1]);
  }, 60_000);

  describe('an invite judged once the admission holds its org and invite locks', () => {
    const PARKS: Record<string, { table: string; row: (i: Invited) => string }> = {
      'its org deleted': { table: 'organizations', row: (i) => i.orgId },
      'it revoked': { table: 'org_invites', row: (i) => i.inviteId },
    };

    /** Send `admit` while the side connection holds the row `park` names FOR UPDATE, then delete that row and let it go. */
    async function parked(
      invited: Invited,
      park: { table: string; row: (i: Invited) => string },
      admit: () => request.Test,
    ): Promise<request.Response> {
      await side.query('BEGIN');
      try {
        await side.query(`SELECT 1 FROM ${park.table} WHERE id = $1 FOR UPDATE`, [park.row(invited)]);
        const settled = admit().then((res) => res);
        await lockWaiters(1);
        await side.query(`DELETE FROM ${park.table} WHERE id = $1`, [park.row(invited)]);
        await side.query('COMMIT');
        return await settled;
      } catch (err) {
        await side.query('ROLLBACK');
        throw err;
      }
    }

    for (const [name, park] of Object.entries(PARKS)) {
      it(`refuses a password sign-up with ${name} while it waits, making no account`, async () => {
        await freshInstance({});
        const owner = await from(app)
          .post('/api/auth/local/register')
          .send({ email: 'owner@example.com', password: PASSWORD })
          .expect(201);
        const invited = await inviteFrom(owner.body.token as string, 'joiner@example.com');
        const res = await parked(invited, park, () =>
          from(app)
            .post('/api/auth/local/register')
            .send({ email: 'joiner@example.com', password: PASSWORD, invite_token: invited.token }),
        );
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'signup_closed' });
        expect(await count(`SELECT 1 FROM users`)).toBe(1);
      }, 60_000);

      it(`still makes the single sign-on account with ${name} while it waits, joining nothing`, async () => {
        await freshInstance(ssoEnv());
        const first = await startSso();
        answerFlows([{ code: 'owner', flow: first, sub: 'sub-owner', email: 'owner@example.com' }]);
        const owner = await completeSso(first, 'owner').expect(200);
        const invited = await inviteFrom(owner.body.token as string, 'joiner@example.com');
        const flow = await startSso('/api/auth/oidc/start', { invite_token: invited.token });
        answerFlows([{ code: 'joiner', flow, sub: 'sub-joiner', email: 'joiner@example.com' }]);
        const res = await parked(invited, park, () => completeSso(flow, 'joiner'));
        expect(res.status).toBe(200);
        expect(res.body.joined_org_id).toBeUndefined();
        expect(await count(`SELECT 1 FROM users`)).toBe(2);
        expect(
          await count(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [
            invited.orgId,
            res.body.user.id,
          ]),
        ).toBe(0);
      }, 60_000);
    }
  });

  describe('an invite into a personal workspace, as an earlier version could make one', () => {
    let ownerId = '';
    let personal = '';
    let team = '';

    /** A pending invite to `email` into `orgId`, written as the earlier version wrote one. */
    async function seededInvite(orgId: string, email: string): Promise<string> {
      const token = randomBytes(24).toString('hex');
      await db.query(
        `INSERT INTO org_invites (id, org_id, email, role, token, created_by, created_at, expires_at)
         VALUES (gen_random_uuid(), $1, $2, 'member', $3, $4, now(), now() + interval '14 days')`,
        [orgId, email, token, ownerId],
      );
      return token;
    }

    const membershipsOf = async (userId: string): Promise<Array<{ org_id: string; role: string }>> =>
      (
        await db.query<{ org_id: string; role: string }>(
          `SELECT org_id, role FROM org_members WHERE user_id = $1 ORDER BY created_at`,
          [userId],
        )
      ).rows;
    const ownWorkspaceOf = async (userId: string): Promise<string> =>
      (await db.query<{ id: string }>(`SELECT id FROM organizations WHERE personal_owner_id = $1`, [userId]))
        .rows[0]!.id;
    const ownerOnly = async (): Promise<void> => {
      expect(await count(`SELECT 1 FROM org_members WHERE org_id = $1`, [personal])).toBe(1);
      expect(
        await count(`SELECT 1 FROM org_invites WHERE org_id = $1 AND accepted_at IS NOT NULL`, [personal]),
      ).toBe(0);
    };

    /** An account that already exists at `email`, with its own workspace, signed in. */
    async function existingAccount(email: string): Promise<{ id: string; session: string }> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, $2, now(), now())`,
        [id, email],
      );
      await insertPersonalOrgs(db, { id: randomUUID(), userId: id, name: email });
      return { id, session: (await mintSession(id, SSO_SECRET_KEY)).token };
    }

    /** A first sign-in of `sub` carrying `token`, whose account another admission makes while it waits for the admission lock. */
    async function racedSignIn(
      sub: string,
      email: string,
      token: string,
    ): Promise<{ res: request.Response; id: string }> {
      const flow = await startSso('/api/auth/oidc/start', { invite_token: token });
      answerFlows([{ code: sub, flow, sub, email }]);
      const id = randomUUID();
      await side.query('SELECT pg_advisory_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
      let signingIn: Promise<request.Response>;
      try {
        signingIn = completeSso(flow, sub).then((res) => res);
        await waitersOnAdmission(1);
        await side.query(
          `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, $2, now(), now())`,
          [id, email],
        );
        await insertPersonalOrgs(side, { id: randomUUID(), userId: id, name: email });
        await side.query(
          `INSERT INTO user_identities (id, user_id, issuer, subject, email_at_link) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), id, idp.issuer, sub, email],
        );
      } finally {
        await side.query('SELECT pg_advisory_unlock($1, 0)', [ADMISSION_LOCK_SPACE]);
      }
      return { res: await signingIn, id };
    }

    beforeAll(async () => {
      await freshInstance({ ...ssoEnv(), LOCAL_AUTH_ENABLED: 'true' });
      const owner = await from(app)
        .post('/api/auth/local/register')
        .send({ email: 'owner@example.com', password: PASSWORD })
        .expect(201);
      ownerId = owner.body.user.id as string;
      personal = await ownWorkspaceOf(ownerId);
      team = (
        await from(app)
          .post('/api/orgs')
          .set('Authorization', `Bearer ${owner.body.token as string}`)
          .send({ name: 'Team' })
          .expect(201)
      ).body.id as string;
    }, 60_000);

    it('previews and accepts it as a spent invite, and the account at its address joins nothing, while one into a shared organization joins it', async () => {
      const reader = await existingAccount('reader@example.com');
      const token = await seededInvite(personal, 'reader@example.com');
      const shared = await seededInvite(team, 'reader@example.com');

      await from(app).get(`/api/orgs/invites/${token}`).expect(404);
      const refused = await from(app)
        .post(`/api/orgs/invites/${token}/accept`)
        .set('Authorization', `Bearer ${reader.session}`)
        .expect(404);
      expect(refused.body.detail).toBe('Invite not found or expired');
      await ownerOnly();

      expect((await from(app).get(`/api/orgs/invites/${shared}`).expect(200)).body.org_id).toBe(team);
      const joined = await from(app)
        .post(`/api/orgs/invites/${shared}/accept`)
        .set('Authorization', `Bearer ${reader.session}`)
        .expect(200);
      expect(joined.body.org_id).toBe(team);
    }, 60_000);

    it('refuses a password sign-up carrying it as signup_closed, making no account, while one into a shared organization makes the account and joins it', async () => {
      const token = await seededInvite(personal, 'signup@example.com');
      const shared = await seededInvite(team, 'signup@example.com');
      const register = (invite: string) =>
        from(app)
          .post('/api/auth/local/register')
          .send({ email: 'signup@example.com', password: PASSWORD, invite_token: invite });

      const refused = await register(token);
      expect({ status: refused.status, code: refused.body.code }).toEqual({
        status: 403,
        code: 'signup_closed',
      });
      expect(await count(`SELECT 1 FROM users WHERE email = 'signup@example.com'`)).toBe(0);
      await ownerOnly();

      const joined = await register(shared).expect(201);
      expect(joined.body.joined_org_id).toBe(team);
    }, 60_000);

    it('still makes the single sign-on account carrying it on a first sign-in, and signs it in again with it, joining nothing either time, while one into a shared organization joins it', async () => {
      const token = await seededInvite(personal, 'sso@example.com');
      const shared = await seededInvite(team, 'sso@example.com');
      const signIn = async (code: string, invite: string): Promise<request.Response> => {
        const flow = await startSso('/api/auth/oidc/start', { invite_token: invite });
        answerFlows([{ code, flow, sub: 'sub-sso', email: 'sso@example.com' }]);
        return completeSso(flow, code);
      };

      const first = await signIn('first', token);
      expect({ status: first.status, joined: first.body.joined_org_id }).toEqual({
        status: 200,
        joined: undefined,
      });
      const id = first.body.user.id as string;
      const own = [{ org_id: await ownWorkspaceOf(id), role: 'owner' }];
      expect(await membershipsOf(id)).toEqual(own);

      const known = await signIn('known', token);
      expect({ status: known.status, user: known.body.user.id, joined: known.body.joined_org_id }).toEqual({
        status: 200,
        user: id,
        joined: undefined,
      });
      expect(await membershipsOf(id)).toEqual(own);
      await ownerOnly();

      const joined = await signIn('shared', shared);
      expect(joined.body.joined_org_id).toBe(team);
    }, 60_000);

    it('joins nothing through it when the account appears while the first sign-in waits for the admission lock, while one into a shared organization joins it', async () => {
      const token = await seededInvite(personal, 'raced@example.com');
      const { res, id } = await racedSignIn('sub-raced', 'raced@example.com', token);
      expect({ status: res.status, user: res.body.user?.id, joined: res.body.joined_org_id }).toEqual({
        status: 200,
        user: id,
        joined: undefined,
      });
      expect(await membershipsOf(id)).toEqual([{ org_id: await ownWorkspaceOf(id), role: 'owner' }]);
      await ownerOnly();

      const shared = await seededInvite(team, 'raced.too@example.com');
      const control = await racedSignIn('sub-raced-too', 'raced.too@example.com', shared);
      expect({ status: control.res.status, joined: control.res.body.joined_org_id }).toEqual({
        status: 200,
        joined: team,
      });
    }, 60_000);
  });

  it('makes the operator CLI take its turn too, so a first sign-in it races lands in the account it links', async () => {
    await freshInstance({ ...ssoEnv(), LOCAL_AUTH_ENABLED: 'true' });
    const owner = await from(app)
      .post('/api/auth/local/register')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(201);
    const signIn = await startSso();
    answerFlows([{ code: 'sign-in', flow: signIn, sub: 'cli-sub', email: 'newcomer@example.com' }]);

    await side.query('SELECT pg_advisory_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
    let linking: Promise<{ code: number; out: string }>;
    let signingIn: Promise<request.Response>;
    try {
      linking = linkSso('owner@example.com', 'cli-sub');
      await waitersOnAdmission(1, 1_200);
      signingIn = completeSso(signIn, 'sign-in').then((res) => res);
      await waitersOnAdmission(2);
    } finally {
      await side.query('SELECT pg_advisory_unlock($1, 0)', [ADMISSION_LOCK_SPACE]);
    }

    expect(await linking).toEqual({
      code: 0,
      out: expect.stringContaining('Linked owner@example.com to cli-sub'),
    });
    const signedIn = await signingIn;
    expect({ status: signedIn.status, user: signedIn.body.user?.id }).toEqual({
      status: 200,
      user: owner.body.user.id,
    });
    expect([await count(`SELECT 1 FROM users`), await count(`SELECT 1 FROM user_identities`)]).toEqual([
      1, 1,
    ]);
  }, 90_000);

  it('lets the operator CLI move an identity off an account disconnecting it at that moment, both completing instead of deadlocking', async () => {
    await freshInstance({ ...ssoEnv(), LOCAL_AUTH_ENABLED: 'true' });
    const owner = await from(app)
      .post('/api/auth/local/register')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(201);
    const invited = await inviteFrom(owner.body.token as string, 'holder@example.com');
    const holder = await from(app)
      .post('/api/auth/local/register')
      .send({ email: 'holder@example.com', password: PASSWORD, invite_token: invited.token })
      .expect(201);
    const session = holder.body.token as string;
    const link = await startSso('/api/auth/oidc/link/start', { current_password: PASSWORD }, session);
    answerFlows([{ code: 'link', flow: link, sub: 'moving-sub', email: 'holder.sso@example.com' }]);
    await completeSso(link, 'link', '/api/auth/oidc/link/complete', session).expect(200);

    const gate = gateEmits('user.identity_unlinked');
    const before = await deadlocks();
    let unlinking: Promise<request.Response>;
    let moving: Promise<{ code: number; out: string }>;
    try {
      unlinking = from(app)
        .delete('/api/auth/oidc/link')
        .set('Authorization', `Bearer ${session}`)
        .then((res) => res);
      await gate.arrived(0);
      moving = linkSso('owner@example.com', 'moving-sub', '--move');
      await lockWaiters(1, 1_200);
    } finally {
      gate.restore();
    }
    const [unlinked, moved] = await Promise.all([unlinking, moving]);

    expect(unlinked.status).toBe(204);
    expect(moved).toEqual({
      code: 0,
      out: expect.stringContaining('Linked owner@example.com to moving-sub'),
    });
    expect(await deadlocksSince(before)).toBe(0);
    const holders = await db.query(`SELECT user_id FROM user_identities WHERE subject = 'moving-sub'`);
    expect(holders.rows).toEqual([{ user_id: owner.body.user.id }]);
  }, 90_000);

  it('lets an account taking the address its provider now confirms and a first sign-in at that address take turns, so one account holds it', async () => {
    await freshInstance(ssoEnv());
    const first = await startSso();
    answerFlows([{ code: 'owner', flow: first, sub: 'sub-renamed', email: 'before@example.com' }]);
    const owner = await completeSso(first, 'owner').expect(200);
    const returning = await startSso();
    const newcomer = await startSso();
    answerFlows([
      { code: 'returning', flow: returning, sub: 'sub-renamed', email: 'wanted@example.com' },
      { code: 'newcomer', flow: newcomer, sub: 'sub-newcomer', email: 'wanted@example.com' },
    ]);

    await side.query('SELECT pg_advisory_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
    let taking: Promise<request.Response>;
    let arriving: Promise<request.Response>;
    try {
      taking = completeSso(returning, 'returning').then((res) => res);
      await waitersOnAdmission(1);
      arriving = completeSso(newcomer, 'newcomer').then((res) => res);
      await waitersOnAdmission(2);
    } finally {
      await side.query('SELECT pg_advisory_unlock($1, 0)', [ADMISSION_LOCK_SPACE]);
    }
    const [took, arrived] = await Promise.all([taking, arriving]);

    expect({ status: took.status, email: took.body.user?.email }).toEqual({
      status: 200,
      email: 'wanted@example.com',
    });
    expect({ status: arrived.status, code: arrived.body.code }).toEqual({
      status: 409,
      code: 'oidc_account_exists',
    });
    const holders = await db.query(
      `SELECT id FROM users WHERE lower(email) = 'wanted@example.com' AND email_verified`,
    );
    expect(holders.rows).toEqual([{ id: owner.body.user.id }]);
    expect(await count(`SELECT 1 FROM users`)).toBe(1);
  }, 60_000);

  it('lets a link and a first sign-in of the same identity take turns, so the sign-in lands in the linked account', async () => {
    await freshInstance({ ...ssoEnv(), LOCAL_AUTH_ENABLED: 'true' });
    const owner = await from(app)
      .post('/api/auth/local/register')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(201);
    const session = owner.body.token as string;
    const link = await startSso('/api/auth/oidc/link/start', { current_password: PASSWORD }, session);
    const signIn = await startSso();
    answerFlows([
      { code: 'link', flow: link, sub: 'shared-sub', email: 'owner.sso@example.com' },
      { code: 'sign-in', flow: signIn, sub: 'shared-sub', email: 'newcomer@example.com' },
    ]);

    await side.query('SELECT pg_advisory_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
    let linking: Promise<request.Response>;
    let signingIn: Promise<request.Response>;
    try {
      linking = completeSso(link, 'link', '/api/auth/oidc/link/complete', session).then((res) => res);
      await waitersOnAdmission(1);
      signingIn = completeSso(signIn, 'sign-in').then((res) => res);
      await waitersOnAdmission(2);
    } finally {
      await side.query('SELECT pg_advisory_unlock($1, 0)', [ADMISSION_LOCK_SPACE]);
    }
    const [linked, signedIn] = await Promise.all([linking, signingIn]);

    expect(linked.status).toBe(200);
    expect({ status: signedIn.status, user: signedIn.body.user?.id }).toEqual({
      status: 200,
      user: owner.body.user.id,
    });
    expect([await count(`SELECT 1 FROM users`), await count(`SELECT 1 FROM user_identities`)]).toEqual([
      1, 1,
    ]);
  }, 60_000);
});
