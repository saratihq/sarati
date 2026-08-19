import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER = '00000000-0000-0000-0000-000000000001';

describe('workflows read slice (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  const wfId = randomUUID();
  const mainId = randomUUID();
  const featureId = randomUUID();
  const v1Id = randomUUID();
  const v2Id = randomUUID();
  const f1Id = randomUUID();
  const foreignWfId = randomUUID();
  const orphanWfId = randomUUID();

  const irJson = (marker: string): Record<string, unknown> => ({
    version: '1',
    name: `wf-${marker}`,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Trigger',
        node_type: 'orchestr:trigger',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'send',
        name: 'Send Email',
        node_type: 'email.send',
        type_version: 1,
        parameters: { subject: marker },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'send',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';

    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    // Mock user + personal org (provisioning normally does this — seed directly).
    await db.query(
      `INSERT INTO users (id, email, hashed_password, name, created_at, updated_at)
       VALUES ($1, 'test@example.com', 'mock', 'Test User', now(), now())`,
      [MOCK_USER],
    );

    // Workflow with main(v1, v2) + feature branch forked at v2 with one own commit.
    await db.query(
      `INSERT INTO workflows (id, name, description, source, user_id, created_at, updated_at)
       VALUES ($1, 'Test Flow', 'd', 'generated', $2, now(), now())`,
      [wfId, MOCK_USER],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $2, 'main', true, false, now()), ($3, $2, 'feature-x', false, false, now())`,
      [mainId, wfId, featureId],
    );
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, commit_message, branch_id, parent_id, created_at)
       VALUES ($1, $2, 1, $3, 'Initial deployment', $4, NULL, now() - interval '3 hour'),
              ($5, $2, 2, $6, 'Version 2', $4, $1, now() - interval '2 hour'),
              ($7, $2, 1, $8, 'feature work', $9, $5, now() - interval '1 hour')`,
      [
        v1Id,
        wfId,
        JSON.stringify(irJson('v1')),
        mainId,
        v2Id,
        JSON.stringify(irJson('v2')),
        f1Id,
        JSON.stringify(irJson('f1')),
        featureId,
      ],
    );
    await db.query(`UPDATE workflows SET active_version_id = $1, default_branch_id = $2 WHERE id = $3`, [
      v2Id,
      mainId,
      wfId,
    ]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [v2Id, mainId]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [f1Id, featureId]);

    // Tags: prod + latest on main v2, latest + dev on the feature head.
    await db.query(
      `INSERT INTO workflow_version_tags
         (id, workflow_id, version_id, tag, branch_id, activated, created_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'prod', $3, true, now()),
         (gen_random_uuid(), $1, $2, 'latest', $3, true, now()),
         (gen_random_uuid(), $1, $4, 'latest', $5, true, now()),
         (gen_random_uuid(), $1, $4, 'dev', $5, false, now())`,
      [wfId, v2Id, mainId, f1Id, featureId],
    );

    // Foreign + orphan workflows for the authz assertions (E2).
    const foreignUserId = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'foreign@e2e.local', 'Foreign User', now(), now())`,
      [foreignUserId],
    );
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, created_at, updated_at)
       VALUES ($1, 'Foreign', 'generated', $2, now(), now()),
              ($3, 'Orphan', 'generated', NULL, now(), now())`,
      [foreignWfId, foreignUserId, orphanWfId],
    );

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
    process.env.MOCK_AUTH = 'false';
  });

  it('GET /api/workflows — pagination shape, node_types', async () => {
    const res = await request(app.getHttpServer()).get('/api/workflows?limit=10&offset=0').expect(200);
    expect(res.body.total).toBe(1); // only the mock user's workflow
    expect(res.body.has_more).toBe(false);
    expect(res.body.limit).toBe(10);
    const wf = res.body.workflows[0];
    expect(wf.id).toBe(wfId);
    expect(wf.active).toBe(true);
    expect(wf.node_count).toBe(2);
    expect(wf.node_types.sort()).toEqual(['email.send', 'orchestr:trigger']);
    expect(wf.version_count).toBe(3);
  });

  it('GET /api/workflows/:id — detail from the active version', async () => {
    const res = await request(app.getHttpServer()).get(`/api/workflows/${wfId}`).expect(200);
    expect(res.body.current_version).toBe(2);
    expect(res.body.version_count).toBe(3);
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['send', 'trigger']);
  });

  it('GET versions (main) — desc order, full field shape, deduped tags', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/versions?branch=main`)
      .expect(200);
    expect(res.body.active_version_id).toBe(v2Id);
    expect(res.body.versions.map((v: { version_number: number }) => v.version_number)).toEqual([2, 1]);
    const v2 = res.body.versions[0];
    expect(v2.tags.sort()).toEqual(['latest', 'prod']);
    expect(v2.is_fork_point).toBe(false);
    // Full pydantic-shape parity: nullable fields PRESENT.
    expect(v2).toHaveProperty('ir_diff');
    expect(v2).toHaveProperty('workflow_ir');
    expect(v2).toHaveProperty('fork_source_branch');
  });

  it('GET versions (feature) — fork point appended with source branch; branch-scoped tags', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/versions?branch=feature-x`)
      .expect(200);
    const numbers = res.body.versions.map((v: { version_number: number }) => v.version_number);
    expect(numbers).toEqual([1, 2]); // own v1 desc, then fork-point (main v2) appended
    const fork = res.body.versions[1];
    expect(fork.is_fork_point).toBe(true);
    expect(fork.fork_source_branch).toBe('main');
    expect(fork.tags).toEqual([]); // main's prod/latest must NOT leak onto the feature view
    const own = res.body.versions[0];
    expect(own.tags.sort()).toEqual(['dev', 'latest']);
    expect(own.inactive_tags).toEqual(['dev']); // activated=false
  });

  it('GET a version by number scoped to branch', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/versions/1?branch=feature-x`)
      .expect(200);
    expect(res.body.id).toBe(f1Id);
    const main1 = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/versions/1?branch=main`)
      .expect(200);
    expect(main1.body.id).toBe(v1Id);
  });

  it('GET diff — same-branch and cross-branch; unknown branch 404', async () => {
    const same = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_version=1&to_version=2&branch=main`)
      .expect(200);
    expect(same.body.summary).toContain('modification');
    expect(Array.isArray(same.body.entries)).toBe(true);
    expect(same.body).toHaveProperty('renames');

    const cross = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_version=2&to_version=1&from_branch=main&to_branch=feature-x`)
      .expect(200);
    expect(cross.body.from_version).toBe(2);

    const missing = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_version=1&to_version=2&branch=nope`)
      .expect(404);
    expect(missing.body.detail).toContain('Branch not found');
  });

  it('GET diff — branch names with no version numbers diff the two HEADS', async () => {
    const heads = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_branch=main&to_branch=feature-x`)
      .expect(200);
    // main's head is v2, feature-x's head is its own v1 — resolved without either being named.
    expect(heads.body.from_version_id).toBe(v2Id);
    expect(heads.body.to_version_id).toBe(f1Id);
    expect(heads.body.from_branch).toBe('main');
    expect(heads.body.to_branch).toBe('feature-x');

    // A single `branch` names both sides — the same-branch degenerate case is an empty diff.
    const sameHead = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?branch=main`)
      .expect(200);
    expect(sameHead.body.from_version_id).toBe(v2Id);
    expect(sameHead.body.to_version_id).toBe(v2Id);

    const unknown = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_branch=main&to_branch=nope`)
      .expect(404);
    expect(unknown.body.detail).toContain('Branch not found');

    // Naming nothing at all can no longer invent version 0.
    const unnamed = await request(app.getHttpServer()).get(`/api/workflows/${wfId}/diff`).expect(400);
    expect(unnamed.body.detail).toContain('Name what to diff');
  });

  it('E2 authz: a foreign workflow, a NULL-owner one and an unknown id are all the same 404', async () => {
    const foreign = await request(app.getHttpServer()).get(`/api/workflows/${foreignWfId}`).expect(404);
    expect(foreign.body.detail).toContain('not found');
    await request(app.getHttpServer()).get(`/api/workflows/${orphanWfId}`).expect(404);
    await request(app.getHttpServer()).get(`/api/workflows/${randomUUID()}`).expect(404);
    await request(app.getHttpServer()).get('/api/workflows/not-a-uuid').expect(404);
  });

  it('GET /api/workflows/:id/config — native shape: webhook detected, action credential from the catalog', async () => {
    // Auth requirements resolve from the built-in action catalog.
    const deployed = await request(app.getHttpServer())
      .post('/api/deploy')
      .send({
        workflow_json: {
          schema_version: 1,
          name: 'config-shape',
          engine: 'orchestr',
          nodes: [
            {
              id: 'hook',
              name: 'Webhook',
              node_type: 'orchestr:webhook',
              type_version: 1,
              parameters: {},
              position: { x: 0, y: 0 },
              metadata: {},
            },
            {
              id: 'notify',
              name: 'Notify Slack',
              node_type: 'slack.send_channel_message',
              type_version: 1,
              parameters: {},
              position: { x: 300, y: 0 },
              metadata: {},
            },
          ],
          edges: [{ id: 'e1', source_node_id: 'hook', target_node_id: 'notify' }],
        },
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/workflows/${deployed.body.workflow_id}/config`)
      .expect(200);

    // Stable native contract shape.
    expect(res.body).toMatchObject({
      workflow_id: deployed.body.workflow_id,
      webhook_inputs: [],
      has_webhook_trigger: true, // the orchestr:webhook trigger node
      webhook_path: null, // native fire URL is env-scoped, not a node path
      has_chat_trigger: false, // no orchestr:chat node
      chat_path: null,
    });
    // The action's auth requirement is sourced from the native catalog.
    const creds = res.body.credentials as Array<{
      node_type: string;
      auth_type: string;
      configured: boolean;
    }>;
    const slack = creds.find((c) => c.node_type === 'slack.send_channel_message');
    expect(slack).toBeDefined();
    expect(slack!.auth_type).toBe('connection');
    expect(slack!.configured).toBe(false); // no connectionId set on the node
    // The webhook trigger carries no auth → never in the credentials list.
    expect(creds.some((c) => c.node_type === 'orchestr:webhook')).toBe(false);
  });

  it('GET /api/workflows/:id/config — an orchestr:chat workflow reports has_chat_trigger + the env-scoped chat path', async () => {
    const deployed = await request(app.getHttpServer())
      .post('/api/deploy')
      .send({
        workflow_json: {
          schema_version: 1,
          name: 'chat-config-shape',
          engine: 'orchestr',
          nodes: [
            {
              id: 'chat',
              name: 'Chat',
              node_type: 'orchestr:chat',
              type_version: 1,
              parameters: { greeting: 'Hi there' },
              position: { x: 0, y: 0 },
              metadata: {},
            },
            {
              id: 'reply',
              name: 'Reply',
              node_type: 'text.concat',
              type_version: 1,
              parameters: { texts: ['echo: ', '{{trigger.chatInput}}'], separator: '' },
              position: { x: 300, y: 0 },
              metadata: {},
            },
          ],
          edges: [{ id: 'e1', source_node_id: 'chat', target_node_id: 'reply' }],
        },
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/workflows/${deployed.body.workflow_id}/config`)
      .expect(200);

    expect(res.body).toMatchObject({
      workflow_id: deployed.body.workflow_id,
      has_webhook_trigger: false,
      has_chat_trigger: true,
      chat_path: `/api/chat/${deployed.body.workflow_id}`,
    });
  });
});
