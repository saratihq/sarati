import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import type request from 'supertest';

import { ADMISSION_LOCK_SPACE } from '../src/auth/local/admission.service';
import { HostileIdp } from './support/hostile-idp';
import { pause } from './support/lock-probes';
import { bootSsoApp, clientAddress, from, newBinding, snapshotEnv } from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const PASSWORD = 'a-long-enough-passphrase';

/** Admission takes turns on one advisory lock; each race is made deterministic by holding it from a side connection until every contender waits. */
describe('account admission takes turns (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let side: Client;
  let restoreEnv: () => void;
  const idp = new HostileIdp();

  async function waitersOnAdmission(count: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
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

  async function freshInstance(env: Record<string, string>): Promise<void> {
    await app?.close();
    await db?.end();
    await side?.end();
    const url = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: url });
    side = new Client({ connectionString: url });
    await db.connect();
    await side.connect();
    app = await bootSsoApp(url, env);
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
});
