import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { ApiKeysService } from '../src/api-keys/api-keys.service';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A NON-mock app — MOCK_AUTH is read once at boot, so the `ork_` key is the only credential here. */
describe('API-key authentication (e2e, isolated DB, no mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  const userId = randomUUID();
  const goodKey = 'ork_live_test_key_value_1234567890';
  const revokedKey = 'ork_revoked_key_value_0987654321';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'apikey@e2e.local', 'Key Owner', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'active', $2, 'ork_live_tes', now()),
              (gen_random_uuid(), $1, 'revoked', $3, 'ork_revoked_', now())`,
      [userId, hash(goodKey), hash(revokedKey)],
    );
    await db.query(`UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1`, [hash(revokedKey)]);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = ''; // no Clerk — API key is the only path
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

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

  it('a new key must name its scopes — a stored null means full authority', async () => {
    const keys = app.get(ApiKeysService);
    await expect(keys.issue(userId, null, 'no scopes', null)).rejects.toThrow(/must name its scopes/);
    await expect(keys.issue(userId, null, 'empty scopes', [])).rejects.toThrow(/must name its scopes/);

    const issued = await keys.issue(userId, null, 'scoped', ['workflow:read']);
    expect(issued.key).toMatch(/^ork_/);
    const row = await db.query(`SELECT scopes FROM api_keys WHERE prefix = $1`, [issued.prefix]);
    expect(row.rows[0].scopes).toEqual(['workflow:read']);
  });

  it('a valid ork_ key resolves to its owner + updates last_used_at', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${goodKey}`)
      .expect(200);
    expect(res.body.user.email).toBe('apikey@e2e.local');

    const rows = await db.query(`SELECT last_used_at FROM api_keys WHERE key_hash = $1`, [hash(goodKey)]);
    expect(rows.rows[0].last_used_at).not.toBeNull();
  });

  it('no token → 401; unknown ork_ key → 401; revoked key → 401', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer ork_nope')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${revokedKey}`)
      .expect(401);
  });

  /** Key management is SESSION-ONLY: `key:manage` is unsatisfiable by ANY key, legacy included. */
  it('a key can NEVER manage keys — mint, list, or revoke (escalation closed)', async () => {
    for (const call of [
      request(app.getHttpServer()).post('/api/api-keys').send({ name: 'ci' }),
      request(app.getHttpServer()).get('/api/api-keys'),
      request(app.getHttpServer()).delete(`/api/api-keys/${randomUUID()}`),
    ]) {
      const res = await call.set('Authorization', `Bearer ${goodKey}`).expect(403);
      expect(String(res.body.detail)).toMatch(/API keys cannot manage API keys/i);
    }
  });

  it('a SCOPED key is held to its scopes, and an unscoped route denies', async () => {
    const readKey = 'ork_scoped_read_only_key_00000001';
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, 'read-only', $2, 'ork_scoped_r', $3::json, now())`,
      [userId, hash(readKey), JSON.stringify(['workflow:read'])],
    );

    // Held scope → allowed.
    await request(app.getHttpServer())
      .get('/api/workflows')
      .set('Authorization', `Bearer ${readKey}`)
      .expect(200);

    // Missing scope → refused, and the message names what is missing.
    const denied = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .set('Authorization', `Bearer ${readKey}`)
      .send({ workflow_ir: { version: '1', nodes: [], edges: [] } })
      .expect(403);
    expect(String(denied.body.detail)).toMatch(/missing the "run:execute" scope/i);

    // Deploy is a separate capability from authoring — a read key cannot promote.
    await request(app.getHttpServer())
      .post(`/api/workflows/${randomUUID()}/publish`)
      .set('Authorization', `Bearer ${readKey}`)
      .send({})
      .expect(403);
  });

  it('a key pinned to one org is refused when it asks for another', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const pinnedKey = 'ork_pinned_org_key_0000000000002';
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1,'A',false,now(),now()), ($2,'B',false,now(),now())`,
      [orgA, orgB],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(),$1,$3,'owner',now()), (gen_random_uuid(),$2,$3,'owner',now())`,
      [orgA, orgB, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'org-a-only', $3, 'ork_pinned_o', $4::json, now())`,
      [userId, orgA, hash(pinnedKey), JSON.stringify(['workflow:read'])],
    );

    // Its own org: fine.
    await request(app.getHttpServer())
      .get('/api/workflows')
      .set('Authorization', `Bearer ${pinnedKey}`)
      .set('X-Org-Id', orgA)
      .expect(200);

    // A different org the OWNER legitimately belongs to — membership alone is too weak for a bearer key.
    await request(app.getHttpServer())
      .get('/api/workflows')
      .set('Authorization', `Bearer ${pinnedKey}`)
      .set('X-Org-Id', orgB)
      .expect(403);
  });
});
