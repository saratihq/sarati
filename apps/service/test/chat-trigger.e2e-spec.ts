import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** An `orchestr:chat` node → step → sink; the sink is the unique terminal leaf, so its output is the reply. */
function chatDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'canvas chat target',
    description: '',
    nodes: [
      {
        id: 'chat',
        name: 'On chat message',
        node_type: 'orchestr:chat',
        type_version: 1,
        parameters: { greeting: 'Hi there' },
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'step',
        name: 'Wrap',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['[', '{{trigger.chatInput}}', ']'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
      {
        id: 'sink',
        name: 'Reply',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['reply=', '{{step}}'], separator: '' },
        position: { x: 600, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-chat-step',
        source_node_id: 'chat',
        source_port: 0,
        target_node_id: 'step',
        target_port: 0,
        port_type: 'main',
      },
      {
        id: 'e-step-sink',
        source_node_id: 'step',
        source_port: 0,
        target_node_id: 'sink',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** A webhook-only workflow — has NO orchestr:chat node, so the chat intake must 404. */
function webhookDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'canvas webhook only',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a request arrives',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['ok'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-announce',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** The synchronous chat-intake model (ADR 0045 addendum): activate, then reply with the terminal output. */
describe('canvas-node chat trigger — activation + synchronous intake (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID();
  const keyA = 'ork_e2e_chattrig_aaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';
  let v1Id = '';
  let webhookWfId = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-chat@e2e.local', 'Owner Chat', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userA, hash(keyA), keyA.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    // The chat intake awaits the run, so it needs the direct interpreter path (DBOS OFF).
    process.env.DBOS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('deploy publishes the chat-trigger version to production', async () => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: chatDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;

    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    v1Id = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!.id;

    const rows = await db.query(
      `SELECT environment, version_id FROM workflow_env_pointers WHERE workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toEqual([{ environment: 'production', version_id: v1Id }]);
  });

  it('the reconciler activates the chat trigger for production (a distinct `chat` activation)', async () => {
    await app.get(TriggerReconcilerService).reconcile(wfId);

    const rows = await db.query(
      `SELECT a.kind, a.trigger_type, a.trigger_node_id, a.version_id, a.paused, e.name AS env
         FROM runtime_trigger_activations a
         JOIN environments e ON e.id = a.environment_id
        WHERE a.workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toEqual([
      {
        kind: 'chat',
        trigger_type: 'orchestr:chat',
        trigger_node_id: 'chat',
        version_id: v1Id,
        paused: false,
        env: 'production',
      },
    ]);
  });

  it('POST /api/chat/<wf>/production runs synchronously and returns the terminal-node output as the reply', async () => {
    const res = await http().post(`/api/chat/${wfId}/production`).send({ chatInput: 'hello' }).expect(200);
    // reply == the unique terminal leaf (`sink`) output.
    expect(res.body.reply).toBe('reply=[hello]');
    expect((res.body.outputs as Record<string, unknown>).sink).toBe('reply=[hello]');
    expect((res.body.outputs as Record<string, unknown>).step).toBe('[hello]');
    expect(typeof res.body.run_id).toBe('string');
    // session_id is minted (a uuid) when the client supplies none.
    expect(res.body.session_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('echoes the client-supplied session_id verbatim', async () => {
    const res = await http()
      .post(`/api/chat/${wfId}/production`)
      .send({ chatInput: 'again', sessionId: 'sess-abc-123' })
      .expect(200);
    expect(res.body.session_id).toBe('sess-abc-123');
    expect(res.body.reply).toBe('reply=[again]');
  });

  it('a chat POST to an env with no live version is refused (Save ≠ Live gating)', async () => {
    await http().post(`/api/chat/${wfId}/staging`).send({ chatInput: 'nope' }).expect(404);
  });

  it('a malformed body (missing chatInput) is a 400', async () => {
    await http().post(`/api/chat/${wfId}/production`).send({ notChat: 'x' }).expect(400);
  });

  it('a workflow with no orchestr:chat node 404s on the chat intake', async () => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: webhookDoc() }),
    ).expect(201);
    webhookWfId = deployed.body.workflow_id as string;
    await http().post(`/api/chat/${webhookWfId}/production`).send({ chatInput: 'hi' }).expect(404);
  });

  it('moving the env pointer off deletes the chat activation (derived state, invariant #11)', async () => {
    await db.query(`DELETE FROM workflow_env_pointers WHERE workflow_id = $1`, [wfId]);
    await app.get(TriggerReconcilerService).reconcile(wfId);
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
