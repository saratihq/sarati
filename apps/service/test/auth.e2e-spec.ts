import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/local/password';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

// Throwaway e2e Fernet key (32 zero bytes base64url) — never a real secret.
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CLERK_SECRET_KEY = 'sk_test_e2e';

const VERIFIED = { object: 'verification_otp', status: 'verified', strategy: 'email_code', attempts: 1 };
const UNVERIFIED = { object: 'verification_otp', status: 'unverified', strategy: 'email_code', attempts: 0 };
const CLERK_DOWN_SUB = 'user_clerk_down';
const clerkDown = new Set([CLERK_DOWN_SUB, 'user_placeholder_first']);
const PASSWORD = 'the-legacy-accounts-password';
const PLANTED_PASSWORD = 'only-the-planter-knows-this';

const verifiedPrimary = (email: string, first: string, last: string): Record<string, unknown> => ({
  primary_email_address_id: 'e1',
  email_addresses: [{ id: 'e1', email_address: email, verification: VERIFIED }],
  first_name: first,
  last_name: last,
});

// What the local Clerk Backend API knows; every other sub is a 404 (one in clerkDown a 503), so it provisions as a placeholder.
const CLERK_PROFILES: Record<string, unknown> = {
  user_real: {
    primary_email_address_id: 'e1',
    email_addresses: [
      { id: 'e0', email_address: 'secondary@e2e.local', verification: VERIFIED },
      { id: 'e1', email_address: 'real@e2e.local', verification: VERIFIED },
    ],
    first_name: 'Real',
    last_name: 'Person',
  },
  user_adopt_real: verifiedPrimary('legacy@e2e.local', 'Clerk', 'Name'),
  user_planter: verifiedPrimary('planter@e2e.local', 'Plants', 'Accounts'),
  user_target: verifiedPrimary('target@e2e.local', 'Real', 'Owner'),
  user_new_owner: verifiedPrimary('reassigned@e2e.local', 'New', 'Owner'),
  user_case: verifiedPrimary('Case.Owner@E2E.local', 'Case', 'Owner'),
  user_dup: verifiedPrimary('dup@e2e.local', 'Dup', 'Owner'),
  user_throttled: verifiedPrimary('throttled@e2e.local', 'Many', 'Guesses'),
  user_placeholder_first: verifiedPrimary('first-placeholder@e2e.local', 'Late', 'Profile'),
  user_unverified: {
    primary_email_address_id: 'e1',
    email_addresses: [
      { id: 'e1', email_address: 'victim@e2e.local', verification: UNVERIFIED },
      { id: 'e2', email_address: 'victim-pending@e2e.local', verification: null },
    ],
    first_name: 'Not',
    last_name: 'Victim',
  },
  user_mixed: {
    primary_email_address_id: 'e1',
    email_addresses: [
      { id: 'e1', email_address: 'mixed-victim@e2e.local', verification: UNVERIFIED },
      { id: 'e2', email_address: 'mixed-own@e2e.local', verification: VERIFIED },
    ],
    first_name: 'Mixed',
    last_name: 'Owner',
  },
  user_secondary_held: {
    primary_email_address_id: 'e1',
    email_addresses: [
      { id: 'e1', email_address: 'held-primary@e2e.local', verification: UNVERIFIED },
      { id: 'e2', email_address: 'held@e2e.local', verification: VERIFIED },
    ],
    first_name: 'Held',
    last_name: 'Secondary',
  },
  user_no_primary_id: {
    email_addresses: [{ email_address: 'noprimary@e2e.local', verification: VERIFIED }],
    first_name: 'No',
    last_name: 'Primary',
  },
};

describe('auth slice (e2e, isolated DB)', () => {
  let app: INestApplication;
  let e2eUrl: string;
  let clerkServer: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let passwordHash: string;
  let clientAddress = 0;
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
        const sub = req.url.slice('/v1/users/'.length);
        if (clerkDown.has(sub)) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ code: 'service_unavailable' }] }));
          return;
        }
        const profile = CLERK_PROFILES[sub];
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
    // Clerk and passwords side by side: the instance where any signed-in member can plant a password account.
    process.env.LOCAL_AUTH_ENABLED = 'true';
    // Behind Sarati's own proxy, so each link scenario is its own client to the 5-a-minute limit.
    process.env.TRUST_PROXY_HOPS = '1';

    passwordHash = await hashPassword(PASSWORD);
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
    delete process.env.LOCAL_AUTH_ENABLED;
    delete process.env.TRUST_PROXY_HOPS;
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

  const seedPasswordUser = async (
    email: string,
    name: string,
    clerkUserId: string | null = null,
  ): Promise<string> => {
    const [row] = await query(
      `INSERT INTO users (id, email, hashed_password, name, clerk_user_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now()) RETURNING id`,
      [email, passwordHash, name, clerkUserId],
    );
    return row!.id as string;
  };

  const clerkBearer = async (sub: string): Promise<string> =>
    `Bearer ${await signToken({ sub, azp: 'http://localhost:5173' })}`;

  const signInAs = async (sub: string, status: number): Promise<request.Response> =>
    request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', await clerkBearer(sub))
      .expect(status);

  const linkAs = async (
    sub: string,
    password: string,
    status: number,
    from = `198.51.100.${++clientAddress}`,
  ): Promise<request.Response> =>
    request(app.getHttpServer())
      .post('/api/auth/clerk/link')
      .set('X-Forwarded-For', from)
      .set('Authorization', await clerkBearer(sub))
      .send({ password })
      .expect(status);

  const usersWithEmail = (email: string): Promise<Array<Record<string, unknown>>> =>
    query(
      'SELECT id, name, clerk_user_id, hashed_password FROM users WHERE lower(email) = lower($1) ORDER BY name',
      [email],
    );

  const passwordRow = (
    id: string,
    name: string,
    clerkUserId: string | null = null,
  ): Record<string, unknown> => ({
    id,
    name,
    clerk_user_id: clerkUserId,
    hashed_password: passwordHash,
  });

  const accountOf = (sub: string): Promise<Array<Record<string, unknown>>> =>
    query('SELECT id FROM users WHERE clerk_user_id = $1', [sub]);

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

  it('a failed profile fetch links nothing, not even an account holding its placeholder email', async () => {
    const placeholder = `${CLERK_DOWN_SUB}@users.clerk.local`;
    const heldId = await seedPasswordUser(placeholder, 'Placeholder Holder');

    const res = await signInAs(CLERK_DOWN_SUB, 401);
    expect(res.body).toMatchObject({
      code: 'provisioning_failed',
      detail: expect.stringContaining(placeholder),
    });
    expect((await linkAs(CLERK_DOWN_SUB, PASSWORD, 502)).body.code).toBe('clerk_unavailable');

    expect(await usersWithEmail(placeholder)).toEqual([passwordRow(heldId, 'Placeholder Holder')]);
    expect(await accountOf(CLERK_DOWN_SUB)).toEqual([]);
  });

  it('a Clerk user who already has an account cannot also link another one', async () => {
    const placeheld = await signInAs('user_placeholder_first', 200);
    expect(placeheld.body.user.email).toBe('user_placeholder_first@users.clerk.local');
    clerkDown.delete('user_placeholder_first');
    const legacyId = await seedPasswordUser('first-placeholder@e2e.local', 'Legacy First');

    expect((await linkAs('user_placeholder_first', PASSWORD, 409)).body.code).toBe('clerk_already_linked');

    expect(await usersWithEmail('first-placeholder@e2e.local')).toEqual([
      passwordRow(legacyId, 'Legacy First'),
    ]);
    expect(await accountOf('user_placeholder_first')).toEqual([{ id: placeheld.body.user.id }]);
  });

  it('an unverified email never reaches the password account that holds it', async () => {
    const victimId = await seedPasswordUser('victim@e2e.local', 'Victim');
    const pendingId = await seedPasswordUser('victim-pending@e2e.local', 'Pending Victim');

    const res = await signInAs('user_unverified', 200);
    expect(res.body.user).toMatchObject({ email: 'user_unverified@users.clerk.local', name: 'Not Victim' });
    expect([victimId, pendingId]).not.toContain(res.body.user.id);

    expect(await usersWithEmail('victim@e2e.local')).toEqual([passwordRow(victimId, 'Victim')]);
    expect(await usersWithEmail('victim-pending@e2e.local')).toEqual([
      passwordRow(pendingId, 'Pending Victim'),
    ]);
  });

  it('an unverified primary with a verified secondary records the verified address and reaches neither', async () => {
    const victimId = await seedPasswordUser('mixed-victim@e2e.local', 'Mixed Victim');

    const res = await signInAs('user_mixed', 200);
    expect(res.body.user).toMatchObject({ email: 'mixed-own@e2e.local', name: 'Mixed Owner' });
    expect(res.body.user.id).not.toBe(victimId);

    expect(await usersWithEmail('mixed-victim@e2e.local')).toEqual([passwordRow(victimId, 'Mixed Victim')]);
  });

  it('a verified secondary another account holds is refused, and cannot link even with the password', async () => {
    const heldId = await seedPasswordUser('held@e2e.local', 'Held Account');

    const res = await signInAs('user_secondary_held', 401);
    expect(res.body).toMatchObject({
      code: 'provisioning_failed',
      detail: expect.stringContaining('held@e2e.local'),
    });
    expect((await linkAs('user_secondary_held', PASSWORD, 403)).body.code).toBe('email_unverified');

    expect(await usersWithEmail('held@e2e.local')).toEqual([passwordRow(heldId, 'Held Account')]);
    expect(await accountOf('user_secondary_held')).toEqual([]);
  });

  it('a verified address with no primary id to match is not a primary: refused, never linked', async () => {
    const heldId = await seedPasswordUser('noprimary@e2e.local', 'No Primary');

    expect((await signInAs('user_no_primary_id', 401)).body.code).toBe('provisioning_failed');
    expect((await linkAs('user_no_primary_id', PASSWORD, 403)).body.code).toBe('email_unverified');

    expect(await usersWithEmail('noprimary@e2e.local')).toEqual([passwordRow(heldId, 'No Primary')]);
  });

  it('provisions from the Clerk profile when there is one: the verified primary email and the full name', async () => {
    const res = await signInAs('user_real', 200);
    expect(res.body.user).toMatchObject({ email: 'real@e2e.local', name: 'Real Person' });
  });

  it('a verified primary email links the password account that holds it only with its password (the migration path)', async () => {
    const legacyId = await seedPasswordUser('legacy@e2e.local', 'Legacy Real');

    const offered = await signInAs('user_adopt_real', 401);
    expect(offered.body).toMatchObject({ code: 'account_link_required', email: 'legacy@e2e.local' });
    expect((await linkAs('user_adopt_real', 'not-the-password-at-all', 401)).body.code).toBe(
      'invalid_credentials',
    );
    expect(await usersWithEmail('legacy@e2e.local')).toEqual([passwordRow(legacyId, 'Legacy Real')]);

    const linked = await linkAs('user_adopt_real', PASSWORD, 200);
    expect(linked.body.user).toMatchObject({ id: legacyId, name: 'Legacy Real' });
    expect(await usersWithEmail('legacy@e2e.local')).toEqual([
      passwordRow(legacyId, 'Legacy Real', 'user_adopt_real'),
    ]);
    const events = await query('SELECT type FROM domain_events WHERE subject_id = $1', [legacyId]);
    expect(events.map((e) => e.type)).toEqual(['user.adopted']);
    expect((await signInAs('user_adopt_real', 200)).body.user.id).toBe(legacyId);
  });

  it("a password account planted under someone else's email is never handed to that email's Clerk user", async () => {
    const planter = await clerkBearer('user_planter');
    const org = await request(app.getHttpServer())
      .post('/api/orgs')
      .set('Authorization', planter)
      .send({ name: 'Plant Co' })
      .expect(201);
    const invite = await request(app.getHttpServer())
      .post(`/api/orgs/${org.body.id as string}/invites`)
      .set('Authorization', planter)
      .set('X-Org-Id', org.body.id as string)
      .send({ email: 'target@e2e.local', role: 'member' })
      .expect(201);
    const planted = await request(app.getHttpServer())
      .post('/api/auth/local/register')
      .send({
        email: 'target@e2e.local',
        password: PLANTED_PASSWORD,
        invite_token: invite.body.token as string,
      })
      .expect(201);
    const plantedId = planted.body.user.id as string;
    const key = await request(app.getHttpServer())
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${planted.body.token as string}`)
      .send({ name: 'planted', scopes: ['workflow:read'] })
      .expect(201);

    const victim = await signInAs('user_target', 401);
    expect(victim.body).toMatchObject({ code: 'account_link_required', email: 'target@e2e.local' });
    expect((await linkAs('user_target', PASSWORD, 401)).body.code).toBe('invalid_credentials');
    expect(await accountOf('user_target')).toEqual([]);
    expect(await query('SELECT clerk_user_id FROM users WHERE id = $1', [plantedId])).toEqual([
      { clerk_user_id: null },
    ]);

    for (const credential of [planted.body.token as string, key.body.key as string]) {
      const me = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${credential}`)
        .expect(200);
      expect(me.body.user.id).toBe(plantedId);
    }
  }, 30_000);

  it('a verified email whose account another Clerk user holds is refused, password or not', async () => {
    const heldId = await seedPasswordUser('reassigned@e2e.local', 'First Owner', 'user_old_owner');

    expect((await signInAs('user_new_owner', 401)).body.code).toBe('provisioning_failed');
    expect((await linkAs('user_new_owner', PASSWORD, 409)).body.code).toBe('account_already_linked');

    expect(await usersWithEmail('reassigned@e2e.local')).toEqual([
      passwordRow(heldId, 'First Owner', 'user_old_owner'),
    ]);
    expect(await accountOf('user_new_owner')).toEqual([]);
  });

  it('a verified primary differing only in case offers the link, rather than a second account', async () => {
    const ownerId = await seedPasswordUser('case.owner@e2e.local', 'Case Owner');

    expect((await signInAs('user_case', 401)).body).toMatchObject({
      code: 'account_link_required',
      email: 'Case.Owner@E2E.local',
    });
    expect((await linkAs('user_case', PASSWORD, 200)).body.user.id).toBe(ownerId);
    expect(await usersWithEmail('case.owner@e2e.local')).toEqual([
      passwordRow(ownerId, 'Case Owner', 'user_case'),
    ]);
  });

  it('two accounts sharing an address but for case are neither offered nor linked', async () => {
    const lowerId = await seedPasswordUser('dup@e2e.local', 'Dup Lower');
    const upperId = await seedPasswordUser('DUP@e2e.local', 'Dup Upper');

    expect((await signInAs('user_dup', 401)).body.code).toBe('provisioning_failed');
    expect((await linkAs('user_dup', PASSWORD, 404)).body.code).toBe('no_account_to_link');

    expect(await usersWithEmail('dup@e2e.local')).toEqual([
      passwordRow(lowerId, 'Dup Lower'),
      passwordRow(upperId, 'Dup Upper'),
    ]);
  });

  it('linking takes a Clerk session: none, or a password session, is refused', async () => {
    const none = await request(app.getHttpServer())
      .post('/api/auth/clerk/link')
      .set('X-Forwarded-For', `198.51.100.${++clientAddress}`)
      .send({ password: PASSWORD })
      .expect(401);
    expect(none.body.code).toBe('no_credentials');

    await seedPasswordUser('session@e2e.local', 'Password Session');
    const session = await request(app.getHttpServer())
      .post('/api/auth/local/login')
      .send({ email: 'session@e2e.local', password: PASSWORD })
      .expect(200);
    const local = await request(app.getHttpServer())
      .post('/api/auth/clerk/link')
      .set('X-Forwarded-For', `198.51.100.${++clientAddress}`)
      .set('Authorization', `Bearer ${session.body.token as string}`)
      .send({ password: PASSWORD })
      .expect(401);
    expect(local.body.code).toBe('no_credentials');
  });

  it('a client gets five password guesses a minute at linking', async () => {
    await seedPasswordUser('throttled@e2e.local', 'Many Guesses');
    const from = '203.0.113.7';
    for (let attempt = 0; attempt < 5; attempt++) {
      await linkAs('user_throttled', `wrong-guess-number-${attempt}`, 401, from);
    }
    await linkAs('user_throttled', PASSWORD, 429, from);
    expect(await accountOf('user_throttled')).toEqual([]);
  }, 30_000);
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
