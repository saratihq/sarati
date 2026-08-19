import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
} from '../src/providers/managed-integration-provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A canvas-node polling app-trigger; gmail is the hand-polled one. */
function pollingDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'polling target',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When new mail arrives',
        node_type: 'gmail.gmail_new_email_received',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['polled: ', '{{trigger.title}}'], separator: '' },
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

/** The canvas-node POLLING trigger end to end: only the trigger lifecycle is mocked, the run is real. */
describe('canvas-node polling-trigger activation (e2e, mocked provider)', () => {
  let app: INestApplication;
  let db: Client;
  let provider: ManagedIntegrationProvider;
  let pollSpy: jest.SpyInstance;
  let enableSpy: jest.SpyInstance;

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_polltrig_aaaaaaaaaaaaaaaaaaaaaa';
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
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'poll@e2e.local', 'Poll', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Poll Org', true, now(), now())`,
      [personalA],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [personalA, userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
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

    // Spy ONLY the trigger lifecycle — the real runAction still routes the step natively.
    provider = app.get<ManagedIntegrationProvider>(MANAGED_INTEGRATION_PROVIDER);
    enableSpy = jest.spyOn(provider, 'enableTrigger').mockResolvedValue(undefined);
    jest.spyOn(provider, 'disableTrigger').mockResolvedValue(undefined);
    pollSpy = jest.spyOn(provider, 'pollTrigger').mockResolvedValue([]);

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

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

  /** The newest trigger-sourced run for this workflow, or null. */
  async function latestTriggerRunId(): Promise<string | null> {
    const rows = await db.query(
      `SELECT run_id FROM runtime_runs WHERE workflow_id = $1 AND source = 'trigger' ORDER BY started_at DESC LIMIT 1`,
      [wfId],
    );
    return rows.rows[0]?.run_id ?? null;
  }

  it('deploy + reconcile activates the polling app-trigger for production', async () => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: pollingDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;
    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    v1Id = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!.id;

    // A polling trigger resolves its connection from the env slot, so seed one for a HEALTHY activation.
    const envRow = await db.query(
      `SELECT id FROM environments WHERE org_id = $1 AND lower(name) = 'production'`,
      [orgId],
    );
    const prodEnvId = envRow.rows[0].id as string;
    const connId = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
       VALUES ($1, $2, 'gmail', 'managed', 'enc', now(), 'active', $3)`,
      [connId, userA, orgId],
    );
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'gmail', $2)`,
      [prodEnvId, connId],
    );

    await app.get(TriggerReconcilerService).reconcile(wfId);

    const rows = await db.query(
      `SELECT a.kind, a.trigger_type, a.trigger_node_id, a.version_id, a.connection_id, a.paused, a.last_error, e.name AS env
         FROM runtime_trigger_activations a JOIN environments e ON e.id = a.environment_id
        WHERE a.workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toEqual([
      {
        kind: 'polling',
        trigger_type: 'gmail.gmail_new_email_received',
        trigger_node_id: 'trigger',
        version_id: v1Id,
        connection_id: connId,
        paused: false,
        last_error: null,
        env: 'production',
      },
    ]);
    // The reconciler materialized the live poller (onEnable) with the slot's connection.
    expect(enableSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: 'gmail.gmail_new_email_received',
        auth: { connectionId: connId },
      }),
    );
  });

  it('a poll turn with a NEW event fires a real run of the live version', async () => {
    pollSpy.mockResolvedValueOnce([{ payload: { title: 'hello from the feed' } }]);

    await app.get(TriggersService).runActivationPollCycle();

    // The mock was called with the polling trigger type and the node's props.
    expect(pollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: 'gmail.gmail_new_email_received' }),
    );

    const runId = await latestTriggerRunId();
    expect(runId).not.toBeNull();
    const run = await awaitRun(runId!);
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('polled: hello from the feed');
  });

  it('a poll turn with NO new events fires nothing (and the activation stays clean)', async () => {
    const before = await latestTriggerRunId();
    pollSpy.mockResolvedValueOnce([]);

    await app.get(TriggersService).runActivationPollCycle();

    expect(await latestTriggerRunId()).toBe(before); // no new run
    const err = await db.query(`SELECT last_error FROM runtime_trigger_activations WHERE workflow_id = $1`, [
      wfId,
    ]);
    expect(err.rows[0].last_error).toBeNull();
  });
});
