import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

const doc = (subject: string): Record<string, unknown> => ({
  version: '1.0',
  name: 'rollback target',
  nodes: [
    {
      id: 'send',
      name: 'Send',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts: [subject], separator: '' },
      position: { x: 0, y: 0 },
      metadata: {},
    },
  ],
  edges: [],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

/**
 * Rollback resolves a version the same way every other read does (invariant #1): a bare number that
 * exists on two branches is refused, never rolled back to whichever row the database returned first.
 */
describe('version rollback (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const userId = randomUUID();
  const orgId = randomUUID();
  const wfId = randomUUID();
  const mainId = randomUUID();
  const featureId = randomUUID();
  // A single-branch workflow, so "unambiguous number" stays true no matter what the other tests mint.
  const soloWfId = randomUUID();
  const soloMainId = randomUUID();
  const key = 'ork_rollback_e2e_key_aaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const asOwner = (r: request.Test): request.Test =>
    r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', orgId);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'rollback@e2e.local', 'Rollback Owner', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Rollback Org', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'rollback', $3, 'ork_rollback', now())`,
      [userId, orgId, hash(key)],
    );
    await db.query(
      `INSERT INTO workflows (id, user_id, org_id, name, source, created_at, updated_at)
       VALUES ($1, $2, $3, 'Rollback Flow', 'orchestr', now(), now())`,
      [wfId, userId, orgId],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $3, 'main', true, false, now()),
              ($2, $3, 'feature', false, false, now())`,
      [mainId, featureId, wfId],
    );
    // version_number 1 exists on BOTH branches with different content — the ambiguity to refuse.
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, commit_message, branch_id, parent_id, created_at)
       VALUES (gen_random_uuid(), $1, 1, $2, 'main v1',    $4, NULL, now() - interval '3 hour'),
              (gen_random_uuid(), $1, 2, $3, 'main v2',    $4, NULL, now() - interval '2 hour'),
              (gen_random_uuid(), $1, 1, $5, 'feature v1', $6, NULL, now() - interval '1 hour')`,
      [wfId, doc('main-one'), doc('main-two'), mainId, doc('feature-one'), featureId],
    );
    await db.query(
      `INSERT INTO workflows (id, user_id, org_id, name, source, created_at, updated_at)
       VALUES ($1, $2, $3, 'Solo Flow', 'orchestr', now(), now())`,
      [soloWfId, userId, orgId],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $2, 'main', true, false, now())`,
      [soloMainId, soloWfId],
    );
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, commit_message, branch_id, parent_id, created_at)
       VALUES (gen_random_uuid(), $1, 1, $2, 'solo v1', $4, NULL, now() - interval '2 hour'),
              (gen_random_uuid(), $1, 2, $3, 'solo v2', $4, NULL, now() - interval '1 hour')`,
      [soloWfId, doc('solo-one'), doc('solo-two'), soloMainId],
    );
    await db.query(`UPDATE workflows SET default_branch_id = $1 WHERE id = $2`, [mainId, wfId]);
    await db.query(`UPDATE workflows SET default_branch_id = $1 WHERE id = $2`, [soloMainId, soloWfId]);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 40_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('refuses a bare version number that exists on more than one branch', async () => {
    const res = await asOwner(http().post(`/api/workflows/${wfId}/versions/1/rollback`)).expect(400);
    expect(String(res.body.detail)).toMatch(/ambiguous/i);
    expect(String(res.body.detail)).toMatch(/feature/);
    expect(String(res.body.detail)).toMatch(/main/);
  });

  it('rolls back to the named branch when the number is qualified', async () => {
    const res = await asOwner(
      http().post(`/api/workflows/${wfId}/versions/1/rollback?branch=feature`),
    ).expect(201);

    expect(res.body).toMatchObject({ status: 'rolled_back', rolled_back_to: 1 });

    // Branch-scoped on purpose: the new version's number collides with main's, which is the whole
    // point of the fix — a number alone identifies nothing.
    const restored = await db.query<{ workflow_json: Record<string, unknown>; branch_id: string }>(
      `SELECT workflow_json, branch_id FROM workflow_versions
        WHERE workflow_id = $1 AND version_number = $2 AND branch_id = $3`,
      [wfId, res.body.new_version_number as number, featureId],
    );
    const nodes = restored.rows[0]?.workflow_json.nodes as { parameters: { texts: string[] } }[];
    expect(nodes[0]?.parameters.texts).toEqual(['feature-one']);
    expect(restored.rows[0]?.branch_id).toBe(featureId);
  });

  it('rolls back an unambiguous number without a branch', async () => {
    const res = await asOwner(http().post(`/api/workflows/${soloWfId}/versions/1/rollback`)).expect(201);

    const restored = await db.query<{ workflow_json: Record<string, unknown>; branch_id: string }>(
      `SELECT workflow_json, branch_id FROM workflow_versions
        WHERE workflow_id = $1 AND version_number = $2 AND branch_id = $3`,
      [soloWfId, res.body.new_version_number as number, soloMainId],
    );
    const nodes = restored.rows[0]?.workflow_json.nodes as { parameters: { texts: string[] } }[];
    expect(nodes[0]?.parameters.texts).toEqual(['solo-one']);
    expect(restored.rows[0]?.branch_id).toBe(soloMainId);
  });

  it('refuses an unknown branch instead of silently rolling back another one', async () => {
    await asOwner(http().post(`/api/workflows/${wfId}/versions/1/rollback?branch=nope`)).expect(404);
  });
});
