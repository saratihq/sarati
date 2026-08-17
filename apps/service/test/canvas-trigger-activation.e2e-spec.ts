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

/** The trigger IS the `orchestr:webhook` node (ADR 0018) — its activation derives from the env pointer. */
function webhookDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'canvas webhook target',
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
        parameters: { texts: ['hooked: ', '{{trigger.title}}'], separator: '' },
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

/** The canvas-node trigger model end to end: reconcile the activation, then fire the per-(workflow, env) intake. */
describe('canvas-node trigger activation (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_canvastrig_aaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';
  let v1Id = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-canvas@e2e.local', 'Owner Canvas', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner Canvas', true, now(), now())`,
      [personalA],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [personalA, userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userA, hash(keyA), keyA.slice(0, 12)],
    );

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

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  /** Poll a fire-and-forget run until it settles. */
  async function awaitRun(runId: string): Promise<Record<string, unknown>> {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const res = await asA(http().get(`/api/runs/${runId}`)).expect(200);
      run = res.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return run;
  }

  it('deploy publishes the webhook-trigger version to production', async () => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: webhookDoc() }),
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

  it('deploy: `activated: true` is only said once the activation is materialized — no sweep wait', async () => {
    // Nothing is reconciled by hand here: the deploy above is the only thing that has run.
    const rows = await db.query(
      `SELECT kind, trigger_node_id FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toEqual([{ kind: 'webhook', trigger_node_id: 'trigger' }]);
  });

  it('deploy: a trigger that cannot be stood up reports activated:false and says why', async () => {
    const doc = webhookDoc();
    // A feed nothing serves: the seed poll fails, so the activation cannot be stood up.
    (doc.nodes as Array<Record<string, unknown>>)[0] = {
      id: 'trigger',
      name: 'When an item is published',
      node_type: 'rss.new_item',
      type_version: 1,
      parameters: { url: 'http://127.0.0.1:9/feed.xml' },
      position: { x: 0, y: 0 },
      metadata: { trigger: true },
    };
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: doc }),
    ).expect(201);

    expect(deployed.body.activated).toBe(false);
    // Whichever leg refuses it — the SSRF guard, or the connection itself — the caller is told.
    expect(String(deployed.body.activation_error)).toMatch(/private\/internal address|Couldn't reach it/);
    // …in words, never as a JS error class: this string is shown to the user verbatim.
    expect(String(deployed.body.activation_error)).not.toMatch(/^[A-Z]\w*Error:/);
  });

  it('the reconciler activates the webhook trigger for production (env pointer × trigger node)', async () => {
    // Pointer moves reconcile inline when pg-boss is off; call again — idempotent — to be deterministic.
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
        kind: 'webhook',
        trigger_type: 'orchestr:webhook',
        trigger_node_id: 'trigger',
        version_id: v1Id,
        paused: false,
        env: 'production',
      },
    ]);
  });

  it('POST /api/hooks/<wf>/production fires the live version — a real run completes with the payload', async () => {
    const fired = await http().post(`/api/hooks/${wfId}/production`).send({ title: 'hello' }).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('hooked: hello');
  });

  it('a fire to an env with no live version is refused (Save ≠ Live gating)', async () => {
    await http().post(`/api/hooks/${wfId}/staging`).send({ title: 'nope' }).expect(404);
  });
});
