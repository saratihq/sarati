import { randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { lockProbes } from './support/lock-probes';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const PASSWORD = 'a-long-enough-passphrase';
const ADMITTED = { status: 201, code: undefined };
const CLOSED = { status: 403, code: 'signup_closed' };

interface Answer {
  status: number;
  code: unknown;
}

/** Who a local registration admits: one first account on an empty instance, one account per email, and against an invite only its invitee. */
describe('local registration admission (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let dbUrl = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const { lockWaiters } = lockProbes(
    () => app,
    () => db,
  );

  const register = (email: string, inviteToken?: string): Promise<Answer> =>
    http()
      .post('/api/auth/local/register')
      .send({ email, password: PASSWORD, ...(inviteToken ? { invite_token: inviteToken } : {}) })
      .then((res) => ({ status: res.status, code: res.body.code }));

  const signUpOwner = async (): Promise<string> => {
    const owner = await http()
      .post('/api/auth/local/register')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(201);
    return `Bearer ${owner.body.token as string}`;
  };

  const inviteToNewOrg = async (session: string, name: string, email: string): Promise<string> => {
    const org = await http().post('/api/orgs').set('Authorization', session).send({ name }).expect(201);
    const invite = await http()
      .post(`/api/orgs/${org.body.id as string}/invites`)
      .set('Authorization', session)
      .set('X-Org-Id', org.body.id as string)
      .send({ email, role: 'member' })
      .expect(201);
    return invite.body.token as string;
  };

  const accounts = async (): Promise<string[]> =>
    (await db.query<{ email: string }>(`SELECT email FROM users ORDER BY email`)).rows.map((r) => r.email);

  // A SHARE lock on users lets a registration count and read accounts, and parks it at its insert.
  const sideBySide = async (...registrations: Array<() => Promise<Answer>>): Promise<Answer[]> => {
    const holder = new Client({ connectionString: dbUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE users IN SHARE MODE');
      const answers = registrations.map((send) => send());
      await lockWaiters(registrations.length);
      await holder.query('COMMIT');
      return (await Promise.all(answers)).sort((a, b) => a.status - b.status);
    } finally {
      await holder.end();
    }
  };

  beforeAll(async () => {
    dbUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: dbUrl });
    await db.connect();

    process.env.DATABASE_URL = dbUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DBOS_ENABLED = 'false';
    process.env.SECRET_KEY = 'a-test-secret-key-for-local-sessions';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  beforeEach(async () => {
    await db.query('DELETE FROM organizations');
    await db.query('DELETE FROM users');
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('two first registrations at once admit one account, and the other is refused as signup_closed', async () => {
    const answers = await sideBySide(
      () => register('first@example.com'),
      () => register('second@example.com'),
    );
    expect(answers).toEqual([ADMITTED, CLOSED]);
    expect(await accounts()).toHaveLength(1);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM organizations`);
    expect(rows[0]?.n).toBe(1);
  });

  it('two first registrations of one email at once admit one account, and the other is refused as signup_closed', async () => {
    const answers = await sideBySide(
      () => register('owner@example.com'),
      () => register('owner@example.com'),
    );
    expect(answers).toEqual([ADMITTED, CLOSED]);
    expect(await accounts()).toEqual(['owner@example.com']);
  });

  it('a first registration carrying an invite that names nothing is refused, and the instance still awaits its first account', async () => {
    expect(await register('owner@example.com', randomBytes(24).toString('hex'))).toEqual(CLOSED);
    expect(await accounts()).toEqual([]);
    const status = await http().get('/api/auth/local/status').expect(200);
    expect(status.body.awaiting_bootstrap).toBe(true);
  });

  it('two registrations of one email against two invites at once admit one account, and the other answers email_taken', async () => {
    const session = await signUpOwner();
    const tokens = [
      await inviteToNewOrg(session, 'North', 'both@example.com'),
      await inviteToNewOrg(session, 'South', 'both@example.com'),
    ];

    const answers = await sideBySide(
      () => register('both@example.com', tokens[0]),
      () => register('both@example.com', tokens[1]),
    );
    expect(answers).toEqual([ADMITTED, { status: 409, code: 'email_taken' }]);
    expect(await accounts()).toEqual(['both@example.com', 'owner@example.com']);
    const { rows } = await db.query<{ joined: number; spent: number }>(
      `SELECT (SELECT count(*)::int FROM org_members m JOIN organizations o ON o.id = m.org_id
                WHERE NOT o.is_personal AND m.user_id = (SELECT id FROM users WHERE email = 'both@example.com')) AS joined,
              (SELECT count(*)::int FROM org_invites WHERE accepted_at IS NOT NULL) AS spent`,
    );
    expect(rows[0]).toEqual({ joined: 1, spent: 1 });
  });

  it('a registration against an invite sent to another email is refused as signup_closed, making no account and leaving the invite to its invitee', async () => {
    const token = await inviteToNewOrg(await signUpOwner(), 'Addressed', 'invitee@example.com');

    expect(await register('holder@example.com', token)).toEqual(CLOSED);
    expect(await accounts()).toEqual(['owner@example.com']);
    const pending = await db.query(`SELECT 1 FROM org_invites WHERE token = $1 AND accepted_at IS NULL`, [
      token,
    ]);
    expect(pending.rowCount).toBe(1);

    expect(await register('Invitee@Example.com', token)).toEqual(ADMITTED);
    const { rows } = await db.query<{ joined: number }>(
      `SELECT count(*)::int AS joined FROM org_members m
         JOIN org_invites i ON i.org_id = m.org_id AND i.accepted_by = m.user_id
         JOIN users u ON u.id = m.user_id
        WHERE i.token = $1 AND u.email = 'invitee@example.com'`,
      [token],
    );
    expect(rows[0]?.joined).toBe(1);
  });
});
