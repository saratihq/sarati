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
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
// Throwaway e2e Fernet key (32 zero bytes base64url) — never a real secret.
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('auth slice (e2e, isolated DB)', () => {
  let app: INestApplication;
  let e2eUrl: string;
  let jwksServer: Server;
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
    jwksServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.CLERK_ISSUER = issuer;
    process.env.CLERK_SECRET_KEY = 'sk_test_e2e_invalid'; // profile fetch fails → placeholder path
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
    await new Promise<void>((resolve, reject) => jwksServer.close((e) => (e ? reject(e) : resolve())));
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

    // Placeholder identity (profile fetch fails with the invalid test secret) — parity.
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
