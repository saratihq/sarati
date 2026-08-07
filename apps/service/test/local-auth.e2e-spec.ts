import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const PASSWORD = 'a-long-enough-passphrase';

/** ADR 0054 — the self-host way in: bootstrap the first account, then sign in. */
describe('local email + password auth (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DBOS_ENABLED = 'false';
    process.env.SECRET_KEY = 'a-test-secret-key-for-local-sessions';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('reports that a fresh instance is waiting for its first account', async () => {
    const res = await http().get('/api/auth/local/status').expect(200);
    expect(res.body).toEqual({ enabled: true, awaiting_bootstrap: true });
  });

  it('creates the first account and returns a session that works immediately', async () => {
    const res = await http()
      .post('/api/auth/local/register')
      .send({ email: 'Owner@Example.com', password: PASSWORD, name: 'Owner' })
      .expect(201);

    expect(res.body.user.email).toBe('owner@example.com'); // normalised
    expect(typeof res.body.token).toBe('string');

    const me = await http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token as string}`)
      .expect(200);
    expect(me.body.user.email).toBe('owner@example.com');
  }, 20_000);

  it('never stores the password itself', async () => {
    const row = await db.query<{ hashed_password: string }>(
      `SELECT hashed_password FROM users WHERE email = 'owner@example.com'`,
    );
    const stored = row.rows[0]?.hashed_password ?? '';
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain(PASSWORD);
  });

  it('closes bootstrap the moment an account exists', async () => {
    const status = await http().get('/api/auth/local/status').expect(200);
    expect(status.body.awaiting_bootstrap).toBe(false);

    const res = await http()
      .post('/api/auth/local/register')
      .send({ email: 'stranger@example.com', password: PASSWORD })
      .expect(403);
    expect(res.body.code).toBe('signup_closed');
  }, 20_000);

  it('signs in with the right password and refuses the wrong one identically to an unknown email', async () => {
    const ok = await http()
      .post('/api/auth/local/login')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(200);
    expect(typeof ok.body.token).toBe('string');

    const wrong = await http()
      .post('/api/auth/local/login')
      .send({ email: 'owner@example.com', password: 'not-the-password' })
      .expect(401);
    const unknown = await http()
      .post('/api/auth/local/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);

    // The same answer either way: login must not disclose which accounts exist.
    expect(wrong.body.detail).toBe(unknown.body.detail);
    expect(wrong.body.code).toBe('invalid_credentials');
  }, 30_000);

  it('refuses a password too short to be worth hashing', async () => {
    const res = await http()
      .post('/api/auth/local/register')
      .send({ email: 'short@example.com', password: 'short' })
      .expect(400);
    expect(res.body.code).toBe('password_too_short');
  });

  it('lets an invited teammate register, and lands them in the inviting org', async () => {
    const owner = await http()
      .post('/api/auth/local/login')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(200);
    const token = owner.body.token as string;

    const org = await http()
      .post('/api/orgs')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme' })
      .expect(201);
    const orgId = org.body.id as string;

    const invite = await http()
      .post(`/api/orgs/${orgId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Org-Id', orgId)
      .send({ email: 'teammate@example.com', role: 'member' })
      .expect(201);

    const joined = await http()
      .post('/api/auth/local/register')
      .send({
        email: 'teammate@example.com',
        password: PASSWORD,
        invite_token: invite.body.token as string,
      })
      .expect(201);

    const member = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, joined.body.user.id],
    );
    expect(member.rows[0]?.n).toBe(1);
  }, 30_000);

  it('lets someone with no account at all see which org they were invited to', async () => {
    const owner = await http()
      .post('/api/auth/local/login')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(200);
    const token = owner.body.token as string;
    const org = await http()
      .post('/api/orgs')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Preview Co' })
      .expect(201);
    const invite = await http()
      .post(`/api/orgs/${org.body.id as string}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Org-Id', org.body.id as string)
      .send({ email: 'newcomer@example.com', role: 'member' })
      .expect(201);

    // No Authorization header at all — this is the invitee before they have an account.
    const preview = await http()
      .get(`/api/orgs/invites/${invite.body.token as string}`)
      .expect(200);
    expect(preview.body).toMatchObject({ org_name: 'Preview Co', role: 'member' });
    // The link's holder must not learn who it was addressed to.
    expect(JSON.stringify(preview.body)).not.toContain('newcomer@example.com');
  }, 30_000);

  it('gives an unknown invite token the same answer as an expired one', async () => {
    const res = await http().get(`/api/orgs/invites/${randomUUID()}`).expect(404);
    expect(String(res.body.detail)).toContain('not found or expired');
  });

  it('refuses an invite token that was issued for a different email', async () => {
    const res = await http()
      .post('/api/auth/local/register')
      .send({ email: 'someone-else@example.com', password: PASSWORD, invite_token: randomUUID() })
      .expect(403);
    expect(res.body.code).toBe('signup_closed');
  }, 20_000);

  it('rejects a session signed with a different secret', async () => {
    await http().get('/api/auth/me').set('Authorization', 'Bearer not.a.session').expect(401);
  });
});
