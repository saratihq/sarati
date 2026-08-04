import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { SDK_POLLING_FETCH } from '../src/providers/sdk-polling.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

const FEED_URL = 'https://feed.e2e.local/items';

/** A minimal JSON FetchLikeResponse. */
function res(status: number, body: unknown): FetchLikeResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** Bound to SDK_POLLING_FETCH so the poll never leaves the process; the feed returns `feedItems`. */
let feedItems: unknown[] = [];
const stubFetch: FetchLike = (input) => {
  const url = String(input);
  if (url.includes('conversations.list')) {
    return Promise.resolve(res(200, { ok: true, channels: [], response_metadata: { next_cursor: '' } }));
  }
  return Promise.resolve(res(200, feedItems));
};

/** A canvas doc: an `http.new_item` polling trigger (no-auth) → a step that echoes the polled item. */
function httpPollingDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'sdk http poll target',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a new item is published',
        node_type: 'http.new_item',
        type_version: 1,
        parameters: { url: FEED_URL },
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

/** A canvas doc whose trigger is `slack.new_channel` (a CONNECTION trigger). */
function slackPollingDoc(): Record<string, unknown> {
  const doc = httpPollingDoc();
  doc.name = 'sdk slack poll target';
  (doc.nodes as Array<Record<string, unknown>>)[0] = {
    id: 'trigger',
    name: 'When a channel is created',
    node_type: 'slack.new_channel',
    type_version: 1,
    parameters: {},
    position: { x: 0, y: 0 },
    metadata: { trigger: true },
  };
  return doc;
}

/** The SDK polling rail (ADR 0047) end to end with a stubbed outbound fetch — activate, prime, poll, fire. */
describe('SDK polling-trigger activation (e2e, stubbed fetch)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_sdkpoll_aaaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';
  let v1Id = '';
  let slackWfId = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'sdkpoll@e2e.local', 'SdkPoll', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'SdkPoll Org', true, now(), now())`,
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_POLLING_FETCH)
      .useValue(stubFetch)
      .compile();
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

  async function awaitRun(runId: string): Promise<Record<string, unknown>> {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const r = await asA(http().get(`/api/runs/${runId}`)).expect(200);
      run = r.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return run;
  }

  async function latestTriggerRunId(workflowId: string): Promise<string | null> {
    const rows = await db.query(
      `SELECT run_id FROM runtime_runs WHERE workflow_id = $1 AND source = 'trigger' ORDER BY started_at DESC LIMIT 1`,
      [workflowId],
    );
    return rows.rows[0]?.run_id ?? null;
  }

  it('the catalog surfaces the four SDK polling triggers (OSS rail — no Composio key)', async () => {
    const catalog = await app.get(TriggersService).catalog();
    const byType = new Map(catalog.map((e) => [e.type as string, e]));
    expect(byType.get('rss.new_item')).toMatchObject({ auth: 'none' });
    expect(byType.get('hackernews.new_story')).toMatchObject({ auth: 'none' });
    expect(byType.get('http.new_item')).toMatchObject({ auth: 'none' });
    expect(byType.get('slack.new_channel')).toMatchObject({ auth: 'connection' });
  });

  it('deploy + reconcile activates the no-auth http.new_item trigger WITHOUT a connection', async () => {
    // Priming must swallow this pre-existing item so it never fires as "new" on the first poll.
    feedItems = [{ id: 'a', title: 'pre-existing' }];

    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: httpPollingDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;
    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    v1Id = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!.id;

    await app.get(TriggerReconcilerService).reconcile(wfId);

    const rows = await db.query(
      `SELECT a.kind, a.trigger_type, a.trigger_node_id, a.version_id, a.connection_id, a.paused, a.last_error, e.name AS env
         FROM runtime_trigger_activations a JOIN environments e ON e.id = a.environment_id
        WHERE a.workflow_id = $1`,
      [wfId],
    );
    // A none-scheme SDK polling trigger materializes HEALTHY with NO connection.
    expect(rows.rows).toEqual([
      {
        kind: 'polling',
        trigger_type: 'http.new_item',
        trigger_node_id: 'trigger',
        version_id: v1Id,
        connection_id: null,
        paused: false,
        last_error: null,
        env: 'production',
      },
    ]);
  });

  it('a poll turn fires a run only for the NEW item (priming swallowed the pre-existing one)', async () => {
    // The feed now also carries a genuinely-new item; only it should fire.
    feedItems = [
      { id: 'a', title: 'pre-existing' },
      { id: 'b', title: 'hello from the feed' },
    ];

    await app.get(TriggersService).runActivationPollCycle();

    const runId = await latestTriggerRunId(wfId);
    expect(runId).not.toBeNull();
    const run = await awaitRun(runId!);
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('polled: hello from the feed');

    // Exactly ONE trigger run so far — the pre-existing item never fired.
    const count = await db.query(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1 AND source = 'trigger'`,
      [wfId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('a poll turn with NO new items fires nothing (dedup holds, activation stays clean)', async () => {
    const before = await latestTriggerRunId(wfId);

    await app.get(TriggersService).runActivationPollCycle();

    expect(await latestTriggerRunId(wfId)).toBe(before); // no new run
    const err = await db.query(`SELECT last_error FROM runtime_trigger_activations WHERE workflow_id = $1`, [
      wfId,
    ]);
    expect(err.rows[0].last_error).toBeNull();
  });

  it('a slack.new_channel trigger with no env slot activates but never fires', async () => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: slackPollingDoc() }),
    ).expect(201);
    slackWfId = deployed.body.workflow_id as string;

    await app.get(TriggerReconcilerService).reconcile(slackWfId);

    // The connection trigger activates but is flagged — there is no slot to run as.
    const rows = await db.query(
      `SELECT kind, trigger_type, connection_id, last_error FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [slackWfId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].kind).toBe('polling');
    expect(rows.rows[0].trigger_type).toBe('slack.new_channel');
    expect(rows.rows[0].connection_id).toBeNull();
    expect(rows.rows[0].last_error).toMatch(/connection/i);

    // A poll cycle must not fire a run for a connection trigger with no slot.
    await app.get(TriggersService).runActivationPollCycle();
    expect(await latestTriggerRunId(slackWfId)).toBeNull();
  });
});
