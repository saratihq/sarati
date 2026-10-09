import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

// Throwaway e2e Fernet key (32 zero bytes base64url) — never a real secret.
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CLERK_SECRET_KEY = 'sk_test_e2e';

// What the local Clerk Backend API knows; every other sub is a 404, so it provisions as a placeholder.
const CLERK_PROFILES: Record<string, unknown> = {
  user_real: {
    primary_email_address_id: 'e1',
    email_addresses: [
      { id: 'e0', email_address: 'secondary@e2e.local' },
      { id: 'e1', email_address: 'real@e2e.local' },
    ],
    first_name: 'Real',
    last_name: 'Person',
  },
  user_adopt_real: {
    primary_email_address_id: 'e1',
    email_addresses: [{ id: 'e1', email_address: 'legacy@e2e.local' }],
    first_name: 'Clerk',
    last_name: 'Name',
  },
};

describe('auth slice (e2e, isolated DB)', () => {
  let app: INestApplication;
  let e2eUrl: string;
  let clerkServer: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  const kid = 'e2e-key-1';

  const signToken = (claims: Record<string, unknown>, expiresIn = '5m'): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setIssuer((claims.iss as string) ?? issuer)
      .setExpirationTime(expiresIn)
      .sign(privateKey);

  beforeAll(async () => {
    e2eUrl = await createE2eDatabase(ADMIN_URL);

    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
    clerkServer = createServer((req, res) => {
      if (req.url?.startsWith('/v1/users/')) {
        if (req.headers.authorization !== `Bearer ${CLERK_SECRET_KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ code: 'authentication_invalid' }] }));
          return;
        }
        const profile = CLERK_PROFILES[req.url.slice('/v1/users/'.length)];
        res.writeHead(profile ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(profile ?? { errors: [{ code: 'resource_not_found' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => clerkServer.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(clerkServer.address() as AddressInfo).port}`;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.CLERK_ISSUER = issuer;
    process.env.CLERK_API_URL = issuer;
    process.env.CLERK_SECRET_KEY = CLERK_SECRET_KEY;
    process.env.CLERK_AUTHORIZED_PARTIES = 'http://localhost:5173';
    process.env.MOCK_AUTH = 'false';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => clerkServer.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
  });

  const query = async (sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    const client = new Client({ connectionString: e2eUrl });
    await client.connect();
    try {
      const res = await client.query(sql, params);
      return res.rows as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  };

  it('401 parity: no token → Not authenticated + WWW-Authenticate: Bearer', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    expect(res.body.detail).toBe('Not authenticated');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('401 parity: garbage token → Invalid token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
    expect(res.body.detail).toBe('Invalid token');
  });

  it('401 parity: expired token → Token expired', async () => {
    const token = await signToken({ sub: 'user_expired', azp: 'http://localhost:5173' }, '-2m');
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(res.body.detail).toBe('Token expired');
  });

  it('401 parity: wrong azp → Invalid token', async () => {
    const token = await signToken({ sub: 'user_azp', azp: 'https://evil.example.com' });
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(res.body.detail).toBe('Invalid token');
  });

  it('provisions on first sight: user + settings + personal org + domain event; response parity', async () => {
    const token = await signToken({ sub: 'user_fresh_1', azp: 'http://localhost:5173' });
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Placeholder identity (Clerk has no profile for this sub) — parity.
    expect(res.body.user.email).toBe('user_fresh_1@users.clerk.local');
    // `settings` is a stable, empty shape.
    expect(res.body.settings).toEqual({});

    const users = await query('SELECT id, clerk_user_id FROM users WHERE clerk_user_id = $1', [
      'user_fresh_1',
    ]);
    expect(users).toHaveLength(1);
    const orgs = await query(
      `SELECT o.is_personal, m.role FROM organizations o
       JOIN org_members m ON m.org_id = o.id WHERE m.user_id = $1`,
      [users[0]!.id],
    );
    expect(orgs).toEqual([{ is_personal: true, role: 'owner' }]);
    const events = await query('SELECT type FROM domain_events WHERE actor_user_id = $1', [users[0]!.id]);
    expect(events.map((e) => e.type)).toContain('user.provisioned');

    // Second call: no duplicate provisioning.
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const again = await query('SELECT count(*)::int AS n FROM users WHERE clerk_user_id = $1', [
      'user_fresh_1',
    ]);
    expect(again[0]!.n).toBe(1);
  });

  it('adopts a legacy password-era row by email instead of duplicating (parity)', async () => {
    // The placeholder email for a sub is deterministic, so a legacy row can be seeded to match it.
    await query(
      `INSERT INTO users (id, email, hashed_password, name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'user_adopt_me@users.clerk.local', 'legacy-hash', 'Legacy User', now(), now())`,
    );
    const token = await signToken({ sub: 'user_adopt_me', azp: 'http://localhost:5173' });
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.user.name).toBe('Legacy User'); // adopted, not recreated

    const rows = await query(
      `SELECT count(*)::int AS n FROM users WHERE email = 'user_adopt_me@users.clerk.local'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('provisions from the Clerk profile when there is one: the primary email and the full name', async () => {
    const token = await signToken({ sub: 'user_real', azp: 'http://localhost:5173' });
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.user).toMatchObject({ email: 'real@e2e.local', name: 'Real Person' });
  });

  it('adopts a legacy password-era row by the real email Clerk reports', async () => {
    await query(
      `INSERT INTO users (id, email, hashed_password, name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'legacy@e2e.local', 'legacy-hash', 'Legacy Real', now(), now())`,
    );
    const token = await signToken({ sub: 'user_adopt_real', azp: 'http://localhost:5173' });
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.user.name).toBe('Legacy Real');

    const rows = await query(`SELECT clerk_user_id FROM users WHERE email = 'legacy@e2e.local'`);
    expect(rows).toEqual([{ clerk_user_id: 'user_adopt_real' }]);
  });
});

describe('mock-auth mode (e2e, isolated DB)', () => {
  let app: INestApplication;
  let e2eUrl: string;

  beforeAll(async () => {
    e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('mock user parity: fixed id, /auth/me works without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    expect(res.body.user.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(res.body.user.email).toBe('test@example.com');
  });
});
