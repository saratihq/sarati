import { createHmac } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { nameBasedId } from '../src/database/ids';
import { SDK_POLLING_FETCH } from '../src/providers/sdk-polling.provider';
import { SDK_WEBHOOK_FETCH } from '../src/providers/sdk-webhook.provider';
import { type ReapResult, RunReaperService } from '../src/runs/run-reaper.service';
import { ADMISSION_EPOCH_KEY } from '../src/triggers/activation-store';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const COMPOSIO_SECRET = 'whsec_e2e_admission';
const STRIPE_SECRET = 'whsec_e2e_admission_minted';
const INSTANCE = 'ti_e2e_admission';
const SHARED_INSTANCE = 'ti_e2e_admission_shared';
// Loopback, so the SDK's SSRF guard skips its DNS lookup; `feedFetch` answers the request itself.
const FEED_ORIGIN = 'http://127.0.0.1';

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

const stripeFetch: FetchLike = (input, init) =>
  Promise.resolve(
    String(input).includes('/v1/webhook_endpoints') && (init?.method ?? 'GET').toUpperCase() === 'POST'
      ? jsonResponse(200, { id: 'we_e2e_admission', secret: STRIPE_SECRET })
      : jsonResponse(200, {}),
  );

/** The items each feed path answers. */
const feeds = new Map<string, unknown[]>();
const feedFetch: FetchLike = (input) =>
  Promise.resolve(jsonResponse(200, feeds.get(new URL(String(input)).pathname) ?? []));

function workflowDoc(name: string, trigger: { type: string; parameters?: Record<string, unknown> }) {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Trigger',
        node_type: trigger.type,
        type_version: 1,
        parameters: trigger.parameters ?? {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'say',
        name: 'Say',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['fired'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-say',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'say',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

const INTAKES = ['a native environment webhook', 'a registered SDK webhook', 'a Composio delivery'] as const;
type IntakeName = (typeof INTAKES)[number];

interface Intake {
  method: 'fireWorkflowEnvWebhook' | 'fireComposioDelivery';
  /** Sends one delivery keyed `key`. */
  send(key: string): request.Test;
  /** The run id the delivery keyed `key` was answered for. */
  runId(res: request.Response, key: string): Promise<string>;
}

interface Hold {
  /** Resolves once `count` admissions wait on the held table. */
  held(count?: number): Promise<void>;
  release(): Promise<void>;
}

/** Each intake and the poll answer a delivery only once its run is admitted: recorded, and its DBOS workflow saved. */
describe('intake admission before acknowledgement (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let dbos: Client;
  let systemUrl = '';
  let closed = false;
  const admitted: string[] = [];
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  let nativeWf = '';
  let uncompilableWf = '';
  let stripeWf = '';
  let composioWf = '';
  let sharedWfs: string[] = [];
  let pollWf = '';
  let scheduleWf = '';

  const deploy = async (doc: Record<string, unknown>): Promise<string> =>
    (await http().post('/api/deploy').send({ workflow_json: doc }).expect(201)).body.workflow_id as string;

  /** Commits `doc` on the workflow's head, publishes it and reconciles its triggers. */
  const publish = async (workflowId: string, doc: Record<string, unknown>): Promise<void> => {
    const versions = await http().get(`/api/workflows/${workflowId}/versions`).expect(200);
    const head = (versions.body.versions as Array<{ id: string; version_number: number }>).reduce((a, b) =>
      b.version_number > a.version_number ? b : a,
    );
    await http()
      .post(`/api/workflows/${workflowId}/commit`)
      .send({ workflow_ir: doc, commit_message: 'change the trigger', base_version_id: head.id })
      .expect(201);
    await http().post(`/api/workflows/${workflowId}/publish`).send({}).expect(201);
    await app.get(TriggerReconcilerService).reconcile(workflowId);
  };

  /** Gives the production slot of `workflowId`'s org a new Stripe account. */
  const newStripeAccount = async (workflowId: string): Promise<void> => {
    const [{ org_id: orgId }] = (
      await db.query<{ org_id: string }>(`SELECT org_id FROM workflows WHERE id = $1`, [workflowId])
    ).rows as [{ org_id: string }];
    const connection = (
      await db.query<{ id: string }>(
        `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
         VALUES (gen_random_uuid(), $1, 'stripe', 'token', $2, now(), 'active', $3) RETURNING id`,
        [
          MOCK_USER_ID,
          app.get(EncryptionService).encryptToken(JSON.stringify({ value: 'sk_test_e2e' })),
          orgId,
        ],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id)
       SELECT id, 'stripe', $2 FROM environments WHERE org_id = $1 AND lower(name) = 'production'
       ON CONFLICT (environment_id, app) DO UPDATE SET connection_id = EXCLUDED.connection_id`,
      [orgId, connection],
    );
  };

  const bindComposio = async (workflowId: string, instance: string): Promise<string> => {
    const bound = await db.query<{ id: string }>(
      `UPDATE runtime_trigger_activations
          SET composio_trigger_instance_id = $2, connection_owner_user_id = $3
        WHERE workflow_id = $1 AND kind = 'composio_subscription' RETURNING id`,
      [workflowId, instance, MOCK_USER_ID],
    );
    expect(bound.rowCount).toBe(1);
    return bound.rows[0]!.id;
  };

  const activationOf = async (workflowId: string): Promise<string> =>
    (
      await db.query<{ id: string }>(`SELECT id FROM runtime_trigger_activations WHERE workflow_id = $1`, [
        workflowId,
      ])
    ).rows[0]!.id;

  /** The epoch the activation's runs are named under now. */
  const epochOf = async (activationId: string): Promise<string> => {
    const epoch = await stored(activationId, ADMISSION_EPOCH_KEY);
    expect(epoch).toEqual(expect.any(String));
    return epoch as string;
  };

  /** The run id a registered webhook's delivery keyed `key` is admitted under now. */
  const stripeRunId = async (key: string): Promise<string> => {
    const activation = await activationOf(stripeWf);
    return nameBasedId(activation, await epochOf(activation), key);
  };

  const sendStripe = (id: string): request.Test => {
    const raw = JSON.stringify({
      id,
      object: 'event',
      type: 'customer.created',
      created: 1700000000,
      livemode: false,
      data: { object: { id: `cus_${id}` } },
    });
    const t = '1700000000';
    const v1 = createHmac('sha256', STRIPE_SECRET).update(`${t}.${raw}`).digest('hex');
    return http()
      .post(`/api/hooks/${stripeWf}/production`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', `t=${t},v1=${v1}`)
      .send(raw);
  };

  const composioDelivery = (webhookId: string, instance: string): request.Test => {
    const raw = JSON.stringify({ metadata: { trigger_id: instance }, data: { action: 'push' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature =
      'v1,' + createHmac('sha256', COMPOSIO_SECRET).update(`${webhookId}.${ts}.${raw}`).digest('base64');
    return http()
      .post('/api/hooks/composio')
      .set('Content-Type', 'application/json')
      .set('webhook-id', webhookId)
      .set('webhook-timestamp', ts)
      .set('webhook-signature', signature)
      .send(raw);
  };

  const composioRunId = async (wf: string, webhookId: string): Promise<string> =>
    `${MOCK_USER_ID}:${nameBasedId(await activationOf(wf), webhookId)}`;

  const intakeOf = (name: IntakeName): Intake =>
    ({
      'a native environment webhook': {
        method: 'fireWorkflowEnvWebhook' as const,
        send: (key: string) => http().post(`/api/hooks/${nativeWf}/production`).send({ hello: key }),
        runId: (res: request.Response) => Promise.resolve(res.body.run_id as string),
      },
      'a registered SDK webhook': {
        method: 'fireWorkflowEnvWebhook' as const,
        send: sendStripe,
        runId: async (res: request.Response, key: string) => {
          expect(res.body.run_id).toBe(await stripeRunId(key));
          return res.body.run_id as string;
        },
      },
      'a Composio delivery': {
        method: 'fireComposioDelivery' as const,
        send: (key: string) => composioDelivery(key, INSTANCE),
        runId: async (res: request.Response, key: string) => {
          expect(res.body).toEqual({ status: 'accepted', fired: 1 });
          return nameBasedId(await activationOf(composioWf), key);
        },
      },
    })[name];

  const runsOf = async (workflowId: string): Promise<Array<{ id: string; status: string }>> =>
    (
      await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM runtime_runs WHERE workflow_id = $1 ORDER BY started_at, id`,
        [workflowId],
      )
    ).rows;

  const runRow = async (scoped: string): Promise<Record<string, unknown> | undefined> =>
    (
      await db.query(`SELECT status, error, plan IS NULL AS planless FROM runtime_runs WHERE id = $1`, [
        scoped,
      ])
    ).rows[0] as Record<string, unknown> | undefined;

  const wholeRow = async (scoped: string): Promise<Record<string, unknown> | undefined> =>
    (await db.query(`SELECT * FROM runtime_runs WHERE id = $1`, [scoped])).rows[0] as
      Record<string, unknown> | undefined;

  const stepsOf = async (scoped: string): Promise<string[]> =>
    (
      await db.query<{ node_id: string }>(
        `SELECT node_id FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
        [scoped],
      )
    ).rows.map((r) => r.node_id);

  const workflowStatus = async (scoped: string): Promise<string | null> =>
    (
      await dbos.query<{ status: string }>(
        `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
        [scoped],
      )
    ).rows[0]?.status ?? null;

  /** The run's DBOS workflow records its end just after the run's row does. */
  const workflowSucceeded = (scoped: string) =>
    eventually(
      `${scoped}'s workflow succeed`,
      () => workflowStatus(scoped),
      (status) => status === 'SUCCESS',
    );

  const claimOf = async (webhookId: string): Promise<{ admitted: boolean } | undefined> =>
    (
      await db.query<{ admitted: boolean }>(
        `SELECT admitted_at IS NOT NULL AS admitted FROM composio_webhook_deliveries WHERE webhook_id = $1`,
        [webhookId],
      )
    ).rows[0];

  const stored = async (activationId: string, key: string): Promise<unknown> =>
    (
      await db.query<{ value: unknown }>(
        `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = $2`,
        [activationId, key],
      )
    ).rows[0]?.value ?? null;

  const lastErrorOf = async (activationId: string): Promise<string | null> =>
    (
      await db.query<{ last_error: string | null }>(
        `SELECT last_error FROM runtime_trigger_activations WHERE id = $1`,
        [activationId],
      )
    ).rows[0]!.last_error;

  /** Counts the calls of `method` on `target` that have settled, each call passing through untouched. */
  function settledCalls<T extends object>(target: T, method: keyof T & string): () => number {
    let settled = 0;
    const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
    jest.spyOn(target, method as never).mockImplementation(((...args: unknown[]) => {
      const result = original(...args);
      void result.then(
        () => settled++,
        () => settled++,
      );
      return result;
    }) as never);
    return () => settled;
  }

  /** Holds every insert into `table` of the database at `url` until `release`, watching for waiters through `watch`. */
  async function holdInserts(url: string, table: string, watch: Client, insert: string): Promise<Hold> {
    const locker = new Client({ connectionString: url });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    return {
      held: async (count = 1) => {
        for (let i = 0; i < 400; i++) {
          const waiting = await watch.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
            [`${insert}%`],
          );
          if (waiting.rows[0]!.n >= count) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`${count} admission(s) never waited on the held ${table}`);
      },
      release: async () => {
        await locker.query('COMMIT');
        await locker.end();
      },
    };
  }

  const holdRunInserts = (): Promise<Hold> =>
    holdInserts(process.env.DATABASE_URL!, 'runtime_runs', db, 'INSERT INTO runtime_runs');
  const holdWorkflowSaves = (): Promise<Hold> =>
    holdInserts(systemUrl, 'dbos.workflow_status', dbos, 'INSERT INTO "dbos".workflow_status');

  /** Refuses any run of `workflows` once `allowed` of their runs are recorded, until the next `disarm`. */
  const refuseRuns = (workflows: string[], allowed: number) =>
    db.query(`INSERT INTO e2e_refused_runs (workflows, allowed) VALUES ($1::uuid[], $2)`, [
      workflows,
      allowed,
    ]);
  /** Refuses to save the DBOS workflow of `scoped`, until the next `disarm`. */
  const refuseSave = (scoped: string) =>
    dbos.query(`INSERT INTO e2e_refused_saves (workflow_uuid) VALUES ($1)`, [scoped]);
  const disarm = async () => {
    await db.query(`DELETE FROM e2e_refused_runs`);
    await db.query(`DELETE FROM e2e_refused_marks`);
    await dbos.query(`DELETE FROM e2e_refused_saves`);
  };

  async function eventually<T>(
    what: string,
    read: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never saw ${what}`);
  }

  const untilCompleted = (workflowId: string, count: number) =>
    eventually(
      `${count} completed run(s) of ${workflowId}`,
      () => runsOf(workflowId),
      (runs) => runs.length === count && runs.every((r) => r.status === 'completed'),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(`CREATE TABLE e2e_refused_runs (workflows uuid[] NOT NULL, allowed int NOT NULL)`);
    await db.query(
      `CREATE FUNCTION e2e_refuse_runs() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF EXISTS (SELECT 1 FROM e2e_refused_runs f
                       WHERE NEW.workflow_id = ANY (f.workflows)
                         AND (SELECT count(*) FROM runtime_runs r WHERE r.workflow_id = ANY (f.workflows)) >= f.allowed)
           THEN RAISE EXCEPTION 'e2e: this run is refused';
           END IF;
           RETURN NEW;
         END $$`,
    );
    await db.query(
      `CREATE TRIGGER e2e_refuse_runs BEFORE INSERT ON runtime_runs FOR EACH ROW EXECUTE FUNCTION e2e_refuse_runs()`,
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_WEBHOOK_FETCH)
      .useValue(stripeFetch)
      .overrideProvider(SDK_POLLING_FETCH)
      .useValue(feedFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'ck_e2e_fake_key');
    await seedPlatformKeyEverywhere(app, 'composio_webhook_secret', COMPOSIO_SECRET);

    const system = new URL(process.env.DATABASE_URL);
    system.pathname = `${system.pathname}_dbos`;
    systemUrl = system.toString();
    dbos = new Client({ connectionString: systemUrl });
    await dbos.connect();
    await dbos.query(`CREATE TABLE e2e_refused_saves (workflow_uuid text PRIMARY KEY)`);
    await dbos.query(
      `CREATE FUNCTION e2e_refuse_saves() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF EXISTS (SELECT 1 FROM e2e_refused_saves f WHERE f.workflow_uuid = NEW.workflow_uuid)
           THEN RAISE EXCEPTION 'e2e: this workflow is not saved';
           END IF;
           RETURN NEW;
         END $$`,
    );
    await dbos.query(
      `CREATE TRIGGER e2e_refuse_saves BEFORE INSERT ON dbos.workflow_status FOR EACH ROW EXECUTE FUNCTION e2e_refuse_saves()`,
    );
    await db.query(`CREATE TABLE e2e_refused_marks (activation_id uuid PRIMARY KEY)`);
    await db.query(
      `CREATE FUNCTION e2e_refuse_marks() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.key = 'seen' AND EXISTS (SELECT 1 FROM e2e_refused_marks f WHERE f.activation_id = NEW.activation_id)
           THEN RAISE EXCEPTION 'e2e: this dedupe mark is refused';
           END IF;
           RETURN NEW;
         END $$`,
    );
    await db.query(
      `CREATE TRIGGER e2e_refuse_marks BEFORE INSERT OR UPDATE ON runtime_activation_store FOR EACH ROW EXECUTE FUNCTION e2e_refuse_marks()`,
    );

    nativeWf = await deploy(workflowDoc('native intake', { type: 'orchestr:webhook' }));
    uncompilableWf = await deploy(workflowDoc('uncompilable intake', { type: 'orchestr:webhook' }));

    stripeWf = await deploy(workflowDoc('registered intake', { type: 'stripe.new_customer' }));
    await newStripeAccount(stripeWf);
    await app.get(TriggerReconcilerService).reconcile(stripeWf);

    const composioDoc = (name: string) => workflowDoc(name, { type: 'github.github_commit_event' });
    composioWf = await deploy(composioDoc('composio intake'));
    await bindComposio(composioWf, INSTANCE);
    sharedWfs = [await deploy(composioDoc('shared intake a')), await deploy(composioDoc('shared intake b'))];
    for (const wf of sharedWfs) await bindComposio(wf, SHARED_INSTANCE);

    feeds.set('/items', [{ id: 'primed' }]);
    pollWf = await deploy(
      workflowDoc('polled intake', { type: 'http.new_item', parameters: { url: `${FEED_ORIGIN}/items` } }),
    );
    scheduleWf = await deploy(
      workflowDoc('scheduled intake', { type: 'orchestr:schedule', parameters: { interval_minutes: 60 } }),
    );
  }, 90_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    await disarm();
  });

  afterAll(async () => {
    if (!closed) await app.close();
    await dbos.end();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  async function expectAnsweredOnlyAfter(name: IntakeName, hold: () => Promise<Hold>, key: string) {
    const intake = intakeOf(name);
    const settled = settledCalls(app.get(TriggersService), intake.method);
    const held = await hold();
    let answered = false;
    const answer = intake.send(key).then((res) => {
      answered = true;
      return res;
    });
    try {
      await held.held();
      expect({ intake: settled(), answered }).toEqual({ intake: 0, answered: false });
    } finally {
      await held.release();
    }
    const res = await answer;
    expect(res.status).toBe(202);
    const scoped = `${MOCK_USER_ID}:${await intake.runId(res, key)}`;
    expect(await runRow(scoped)).toMatchObject({ status: expect.any(String) });
    expect(await workflowStatus(scoped)).not.toBeNull();
    admitted.push(scoped);
  }

  it.each(INTAKES)('%s is answered only once its run is recorded', async (name) => {
    await expectAnsweredOnlyAfter(name, holdRunInserts, 'held_at_record');
  });

  it.each(INTAKES)('%s is answered only once its DBOS workflow is saved', async (name) => {
    await expectAnsweredOnlyAfter(name, holdWorkflowSaves, 'held_at_save');
  });

  it('a native environment webhook whose run cannot be recorded is answered 500 and starts nothing', async () => {
    const before = (await runsOf(nativeWf)).map((r) => r.id);
    await refuseRuns([nativeWf], 0);
    await http().post(`/api/hooks/${nativeWf}/production`).send({ hello: 'refused' }).expect(500);
    expect((await runsOf(nativeWf)).map((r) => r.id)).toEqual(before);
  });

  it('a native environment webhook whose pinned version cannot compile is answered 422 and records no run', async () => {
    const loop = {
      id: 'e-loop',
      source_node_id: 'say',
      source_port: 0,
      target_node_id: 'say',
      target_port: 0,
      port_type: 'main',
    };
    await db.query(
      `UPDATE workflow_versions
          SET workflow_ir = jsonb_set(workflow_ir::jsonb, '{edges}', (workflow_ir::jsonb -> 'edges') || $2::jsonb)::json
        WHERE workflow_id = $1`,
      [uncompilableWf, JSON.stringify([loop])],
    );
    const res = await http()
      .post(`/api/hooks/${uncompilableWf}/production`)
      .send({ hello: 'loop' })
      .expect(422);
    expect(String(res.body.detail)).toMatch(/^Workflow can't run: .*cycle/);
    expect(await runsOf(uncompilableWf)).toEqual([]);
  });

  it('a registered SDK webhook whose run cannot be recorded is answered 500 and leaves no dedupe mark, so its resend fires', async () => {
    const before = (await runsOf(stripeWf)).length;
    await refuseRuns([stripeWf], before);
    await sendStripe('evt_admission_refused').expect(500);
    expect(await runsOf(stripeWf)).toHaveLength(before);

    await disarm();
    const resend = await sendStripe('evt_admission_refused').expect(202);
    expect(resend.body).toMatchObject({ fired: 1 });
    const scoped = `${MOCK_USER_ID}:${await stripeRunId('evt_admission_refused')}`;
    expect(await workflowStatus(scoped)).not.toBeNull();
    admitted.push(scoped);
  });

  it('a Composio delivery whose run cannot be recorded is answered 500, its claim not admitted, so its resend fires', async () => {
    const before = (await runsOf(composioWf)).length;
    await refuseRuns([composioWf], before);
    await composioDelivery('msg_admission_refused', INSTANCE).expect(500);
    expect(await runsOf(composioWf)).toHaveLength(before);
    expect(await claimOf('msg_admission_refused')).toEqual({ admitted: false });

    await disarm();
    const resend = await composioDelivery('msg_admission_refused', INSTANCE).expect(202);
    expect(resend.body).toEqual({ status: 'accepted', fired: 1 });
    expect(await claimOf('msg_admission_refused')).toEqual({ admitted: true });
    const scoped = await composioRunId(composioWf, 'msg_admission_refused');
    expect(await workflowStatus(scoped)).not.toBeNull();
    admitted.push(scoped);
    await composioDelivery('msg_admission_refused', INSTANCE).expect(202, {
      status: 'accepted',
      fired: 0,
      duplicate: true,
    });
  });

  it('a Composio delivery whose activation cannot read its version is answered 500, so its resend fires', async () => {
    await db.query(`ALTER TABLE workflow_versions RENAME TO e2e_unreadable_versions`);
    try {
      await composioDelivery('msg_version_unread', INSTANCE).expect(500);
    } finally {
      await db.query(`ALTER TABLE e2e_unreadable_versions RENAME TO workflow_versions`);
    }
    expect(await claimOf('msg_version_unread')).toEqual({ admitted: false });
    const scoped = await composioRunId(composioWf, 'msg_version_unread');
    expect(await runRow(scoped)).toBeUndefined();

    const resend = await composioDelivery('msg_version_unread', INSTANCE).expect(202);
    expect(resend.body).toEqual({ status: 'accepted', fired: 1 });
    expect(await workflowStatus(scoped)).not.toBeNull();
    admitted.push(scoped);
  });

  it('a Composio delivery two activations share, refused after one run is admitted, admits each exactly once across its resend', async () => {
    const all = async () => (await Promise.all(sharedWfs.map(runsOf))).flat().map((r) => r.id);
    await refuseRuns(sharedWfs, 1);
    await composioDelivery('msg_fan_out', SHARED_INSTANCE).expect(500);
    const [first] = await all();
    expect(await all()).toHaveLength(1);
    expect([
      await composioRunId(sharedWfs[0]!, 'msg_fan_out'),
      await composioRunId(sharedWfs[1]!, 'msg_fan_out'),
    ]).toContain(first);
    expect(await workflowStatus(first!)).not.toBeNull();

    await disarm();
    const resend = await composioDelivery('msg_fan_out', SHARED_INSTANCE).expect(202);
    expect(resend.body).toEqual({ status: 'accepted', fired: 2 });
    for (const wf of sharedWfs) {
      const runs = await untilCompleted(wf, 1);
      expect(runs.map((r) => r.id)).toEqual([await composioRunId(wf, 'msg_fan_out')]);
      await workflowSucceeded(runs[0]!.id);
      expect(await stepsOf(runs[0]!.id)).toEqual(['say']);
    }
  });

  it('a Composio resend whose first run ended with no workflow acknowledges that run, and admits the one it missed exactly once', async () => {
    const all = async () => (await Promise.all(sharedWfs.map(runsOf))).flat().map((r) => r.id);
    const ids = await Promise.all(sharedWfs.map((wf) => composioRunId(wf, 'msg_ended_unheld')));
    await refuseRuns(sharedWfs, (await all()).length + 1);
    await composioDelivery('msg_ended_unheld', SHARED_INSTANCE).expect(500);
    const firstRuns = (await all()).filter((id) => ids.includes(id));
    expect(firstRuns).toHaveLength(1);
    const [ended] = firstRuns as [string];
    const missed = ids.find((id) => id !== ended)!;
    await disarm();
    await workflowSucceeded(ended);
    // As a system database that does not hold the run leaves it: DBOS switched on after it ran in process, or restored apart.
    await dbos.query(`DELETE FROM dbos.workflow_status WHERE workflow_uuid = $1`, [ended]);

    const resend = await composioDelivery('msg_ended_unheld', SHARED_INSTANCE).expect(202);
    expect(resend.body).toEqual({ status: 'accepted', fired: 2 });
    expect(await claimOf('msg_ended_unheld')).toEqual({ admitted: true });
    await eventually(
      'the missed run complete',
      () => runRow(missed),
      (row) => row?.status === 'completed',
    );
    await workflowSucceeded(missed);
    for (const id of ids) expect(await stepsOf(id)).toEqual(['say']);
    expect(await workflowStatus(ended)).toBeNull();
    expect(await runRow(ended)).toMatchObject({ status: 'completed' });
  });

  it('a Composio resend arriving while the first delivery is still being admitted admits its runs too, and the run is admitted and runs once', async () => {
    const hold = await holdRunInserts();
    let first: Promise<request.Response>;
    let second: Promise<request.Response>;
    try {
      first = composioDelivery('msg_overlap', INSTANCE).then((res) => res);
      await hold.held(1);
      second = composioDelivery('msg_overlap', INSTANCE).then((res) => res);
      await hold.held(2);
    } finally {
      await hold.release();
    }
    const answers = await Promise.all([first, second]);
    expect(answers.map((res) => [res.status, res.body])).toEqual([
      [202, { status: 'accepted', fired: 1 }],
      [202, { status: 'accepted', fired: 1 }],
    ]);
    const scoped = await composioRunId(composioWf, 'msg_overlap');
    await eventually(
      'the run complete',
      () => runRow(scoped),
      (row) => row?.status === 'completed',
    );
    await workflowSucceeded(scoped);
    expect(await stepsOf(scoped)).toEqual(['say']);
    expect(await claimOf('msg_overlap')).toEqual({ admitted: true });
    await composioDelivery('msg_overlap', INSTANCE).expect(202, {
      status: 'accepted',
      fired: 0,
      duplicate: true,
    });
  });

  it('a Composio delivery whose DBOS workflow cannot be saved leaves its run refused, and its resend takes the run over and runs it', async () => {
    const scoped = await composioRunId(composioWf, 'msg_unsaved');
    await refuseSave(scoped);
    await composioDelivery('msg_unsaved', INSTANCE).expect(500);
    expect(await runRow(scoped)).toEqual({
      status: 'error',
      error: "Workflow can't run: it could not be started: e2e: this workflow is not saved",
      planless: true,
    });
    expect(await workflowStatus(scoped)).toBeNull();
    expect(await claimOf('msg_unsaved')).toEqual({ admitted: false });

    await disarm();
    const resend = await composioDelivery('msg_unsaved', INSTANCE).expect(202);
    expect(resend.body).toEqual({ status: 'accepted', fired: 1 });
    await eventually(
      'the run complete',
      () => runRow(scoped),
      (row) => row?.status === 'completed',
    );
    await workflowSucceeded(scoped);
    expect(await stepsOf(scoped)).toEqual(['say']);
  });

  it('a poll whose second event cannot be admitted moves neither its cursor nor its epoch, and the next poll admits each event exactly once', async () => {
    const activation = await activationOf(pollWf);
    const seen = await stored(activation, 'seen');
    feeds.set('/items', [{ id: 'primed' }, { id: 'one' }, { id: 'two' }]);
    await refuseRuns([pollWf], 1);
    await app.get(TriggersService).runActivationPollCycle();
    const epoch = await epochOf(activation);
    const runOf = (item: string) => `${MOCK_USER_ID}:${nameBasedId(activation, epoch, `id:${item}`)}`;
    expect((await runsOf(pollWf)).map((r) => r.id)).toEqual([runOf('one')]);
    expect(await stored(activation, 'seen')).toEqual(seen);
    expect(await lastErrorOf(activation)).toContain('e2e: this run is refused');

    await disarm();
    await app.get(TriggersService).runActivationPollCycle();
    const runs = await untilCompleted(pollWf, 2);
    expect(runs.map((r) => r.id).sort()).toEqual([runOf('one'), runOf('two')].sort());
    for (const run of runs) {
      await workflowSucceeded(run.id);
      expect(await stepsOf(run.id)).toEqual(['say']);
    }
    expect(await lastErrorOf(activation)).toBeNull();
    expect(await epochOf(activation)).not.toBe(epoch);
    await app.get(TriggersService).runActivationPollCycle();
    expect(await runsOf(pollWf)).toHaveLength(2);
  });

  it('a schedule tick whose run cannot be admitted keeps its cursor, and the next poll admits that tick exactly once', async () => {
    const activation = await activationOf(scheduleWf);
    const lastFire = new Date(Date.now() - 61 * 60_000).toISOString();
    const tick = new Date(Date.parse(lastFire) + 60 * 60_000).toISOString();
    await db.query(
      `UPDATE runtime_activation_store SET value = to_json($2::text) WHERE activation_id = $1 AND key = 'schedule.lastFire'`,
      [activation, lastFire],
    );
    await refuseRuns([scheduleWf], 0);
    await app.get(TriggersService).runActivationPollCycle();
    expect(await runsOf(scheduleWf)).toEqual([]);
    expect(await stored(activation, 'schedule.lastFire')).toBe(lastFire);

    const epoch = await epochOf(activation);

    await disarm();
    await app.get(TriggersService).runActivationPollCycle();
    const [run] = await untilCompleted(scheduleWf, 1);
    expect(run!.id).toBe(`${MOCK_USER_ID}:${nameBasedId(activation, epoch, tick)}`);
    expect(await stored(activation, 'schedule.lastFire')).not.toBe(lastFire);
    await app.get(TriggersService).runActivationPollCycle();
    expect(await runsOf(scheduleWf)).toHaveLength(1);
  });

  it('a polled item whose key its trigger has forgotten, and so yields again, runs again', async () => {
    const activation = await activationOf(pollWf);
    const epoch = await epochOf(activation);
    await db.query(
      `UPDATE runtime_activation_store
          SET value = (SELECT json_agg(k) FROM json_array_elements_text(value) k WHERE k <> 'id:one')
        WHERE activation_id = $1 AND key = 'seen'`,
      [activation],
    );
    await app.get(TriggersService).runActivationPollCycle();
    const runs = await untilCompleted(pollWf, 3);
    const again = `${MOCK_USER_ID}:${nameBasedId(activation, epoch, 'id:one')}`;
    expect(runs.map((r) => r.id)).toContain(again);
    await workflowSucceeded(again);
    expect(await stepsOf(again)).toEqual(['say']);
  });

  it('a polled trigger set up again by a change to its props runs an item whose key a run of its earlier setup was named by', async () => {
    const activation = await activationOf(pollWf);
    const before = (await untilCompleted(pollWf, 3)).map((r) => r.id);
    feeds.set('/after', [{ id: 'primed after' }]);
    await publish(
      pollWf,
      workflowDoc('polled intake', { type: 'http.new_item', parameters: { url: `${FEED_ORIGIN}/after` } }),
    );
    expect(await activationOf(pollWf)).toBe(activation);
    expect(await stored(activation, ADMISSION_EPOCH_KEY)).toBeNull();

    feeds.set('/after', [{ id: 'primed after' }, { id: 'two' }]);
    await app.get(TriggersService).runActivationPollCycle();
    const [after, ...others] = (await untilCompleted(pollWf, 4)).filter((r) => !before.includes(r.id));
    expect(others).toEqual([]);
    await workflowSucceeded(after!.id);
    expect(await stepsOf(after!.id)).toEqual(['say']);
  });

  it('a registered SDK webhook set up again by a change of its account runs a delivery whose key a run of its earlier setup was named by', async () => {
    const activation = await activationOf(stripeWf);
    const epoch = await epochOf(activation);
    const first = await sendStripe('evt_set_up_again').expect(202);
    expect(first.body.run_id).toBe(nameBasedId(activation, epoch, 'evt_set_up_again'));

    await newStripeAccount(stripeWf);
    await app.get(TriggerReconcilerService).reconcile(stripeWf);
    expect(await activationOf(stripeWf)).toBe(activation);
    const renewed = await epochOf(activation);
    expect(renewed).not.toBe(epoch);
    const again = await sendStripe('evt_set_up_again').expect(202);
    expect(again.body.run_id).toBe(nameBasedId(activation, renewed, 'evt_set_up_again'));
    for (const runId of [first.body.run_id as string, again.body.run_id as string]) {
      const scoped = `${MOCK_USER_ID}:${runId}`;
      await workflowSucceeded(scoped);
      expect(await stepsOf(scoped)).toEqual(['say']);
    }
  });

  it('a poll yielding again an event whose run ended with no workflow acknowledges it, so its cursor moves and its next event runs once', async () => {
    feeds.set('/acked', [{ id: 'primed' }]);
    const wf = await deploy(
      workflowDoc('acknowledged intake', {
        type: 'http.new_item',
        parameters: { url: `${FEED_ORIGIN}/acked` },
      }),
    );
    const activation = await activationOf(wf);
    feeds.set('/acked', [{ id: 'primed' }, { id: 'one' }, { id: 'two' }]);
    await refuseRuns([wf], 1);
    await app.get(TriggersService).runActivationPollCycle();
    await disarm();
    const epoch = await epochOf(activation);
    const runOf = (item: string) => `${MOCK_USER_ID}:${nameBasedId(activation, epoch, `id:${item}`)}`;
    expect((await untilCompleted(wf, 1)).map((r) => r.id)).toEqual([runOf('one')]);
    await workflowSucceeded(runOf('one'));
    // As a system database that does not hold the run leaves it: DBOS switched on after it ran in process, or restored apart.
    await dbos.query(`DELETE FROM dbos.workflow_status WHERE workflow_uuid = $1`, [runOf('one')]);

    await app.get(TriggersService).runActivationPollCycle();
    expect(await lastErrorOf(activation)).toBeNull();
    expect(await stored(activation, 'seen')).toEqual(expect.arrayContaining(['id:one', 'id:two']));
    const runs = await untilCompleted(wf, 2);
    expect(runs.map((r) => r.id).sort()).toEqual([runOf('one'), runOf('two')].sort());
    expect(await workflowStatus(runOf('one'))).toBeNull();
    await workflowSucceeded(runOf('two'));
    for (const run of runs) expect(await stepsOf(run.id)).toEqual(['say']);
    await app.get(TriggersService).runActivationPollCycle();
    expect(await runsOf(wf)).toHaveLength(2);
    expect(await lastErrorOf(activation)).toBeNull();
  });

  it('a resend that finds its run left running with no workflow starts its clock again, so a reap while its workflow is saved passes it over, and it runs once', async () => {
    const scoped = await composioRunId(composioWf, 'msg_reaped_resend');
    await refuseSave(scoped);
    await composioDelivery('msg_reaped_resend', INSTANCE).expect(500);
    await disarm();
    // As a service killed between recording the run and saving its workflow leaves it, past the run's maximum duration.
    await db.query(
      `UPDATE runtime_runs
          SET status = 'running', error = NULL, finished_at = NULL, plan_id = 'killed', plan = '{}',
              started_at = now() - interval '61 minutes'
        WHERE id = $1`,
      [scoped],
    );
    expect(await claimOf('msg_reaped_resend')).toEqual({ admitted: false });

    const hold = await holdWorkflowSaves();
    let reaped: ReapResult;
    let answer: Promise<request.Response>;
    try {
      answer = composioDelivery('msg_reaped_resend', INSTANCE).then((res) => res);
      await hold.held();
      reaped = await app.get(RunReaperService).reapStale();
    } finally {
      await hold.release();
    }
    expect(reaped!.crashedRuns).toBe(0);
    expect((await answer!).body).toEqual({ status: 'accepted', fired: 1 });
    await workflowSucceeded(scoped);
    expect(await runRow(scoped)).toMatchObject({ status: 'completed' });
    expect(await stepsOf(scoped)).toEqual(['say']);
    const planOf = async (id: string): Promise<string | undefined> =>
      (await db.query<{ plan_id: string }>(`SELECT plan_id FROM runtime_runs WHERE id = $1`, [id])).rows[0]
        ?.plan_id;
    expect(await planOf(scoped)).not.toBe('killed');
    expect(await planOf(scoped)).toBe(await planOf(await composioRunId(composioWf, 'msg_overlap')));
    expect(await claimOf('msg_reaped_resend')).toEqual({ admitted: true });
  });

  it('an id whose run ended with no workflow, as a dry run does, is refused 409 run_exists and starts none', async () => {
    const plan = {
      id: 'dry-then-real',
      nodes: [{ kind: 'action', id: 'say', actionId: 'text.concat', props: { texts: ['x'], separator: '' } }],
    };
    await http().post('/api/runs').send({ plan, run_id: 'dry-then-real', dry_run: true }).expect(201);
    const real = await http().post('/api/runs').send({ plan, run_id: 'dry-then-real' }).expect(409);
    expect(real.body.code).toBe('run_exists');
    const scoped = `${MOCK_USER_ID}:dry-then-real`;
    expect(await workflowStatus(scoped)).toBeNull();
    expect(await runRow(scoped)).toMatchObject({ status: 'completed' });
    expect(await stepsOf(scoped)).toEqual(['say']);
  });

  /** A run of `wf` under `runId` as the reaper leaves one its service was killed before saving: ended, never started, no workflow. */
  const reapedUnstarted = async (wf: string, runId: string) => {
    const ir = workflowDoc('reaped before it started', { type: 'orchestr:webhook' });
    const scoped = `${MOCK_USER_ID}:${runId}`;
    const fire = () =>
      http().post('/api/runs/from-ir').send({ workflow_ir: ir, workflow_id: wf, run_id: runId });
    await refuseSave(scoped);
    await fire().expect(500);
    await disarm();
    await db.query(
      `UPDATE runtime_runs SET error = 'Run did not complete within the maximum duration', plan = '{}' WHERE id = $1`,
      [scoped],
    );
    return { scoped, fire };
  };

  it('a re-arm held under its run lock finishes before a workflow delete waiting on that run, and both complete', async () => {
    const wf = await deploy(workflowDoc('re-armed then deleted', { type: 'orchestr:webhook' }));
    const { scoped, fire } = await reapedUnstarted(wf, 'rearmed-run');

    const locker = new Client({ connectionString: systemUrl });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE dbos.workflow_status IN ACCESS EXCLUSIVE MODE');
    let run: Promise<request.Response>;
    let deleted: Promise<request.Response>;
    try {
      run = fire().then((res) => res);
      await eventually(
        'the re-arm hold its run lock, past reading the run',
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'idle in transaction'
                  AND query LIKE 'SELECT status FROM runtime_runs WHERE id%'`,
            )
          ).rows.length,
        (n) => n === 1,
      );
      deleted = http()
        .delete(`/api/workflows/${wf}`)
        .then((res) => res);
      await eventually(
        'the workflow delete wait on the run',
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'DELETE FROM workflows%'`,
            )
          ).rows.length,
        (n) => n === 1,
      );
    } finally {
      await locker.query('COMMIT');
      await locker.end();
    }
    const [ran, gone] = await Promise.all([run, deleted]);
    expect([ran.status, gone.status]).toEqual([201, 200]);
    expect(await runRow(scoped)).toMatchObject({ status: 'completed' });
    expect(await stepsOf(scoped)).toEqual(['say']);
    expect((await db.query(`SELECT 1 FROM workflows WHERE id = $1`, [wf])).rows).toEqual([]);
  });

  it('an id whose run ended after it took a step, with no workflow, is refused 409 run_exists and its step is left as it was', async () => {
    const { scoped, fire } = await reapedUnstarted(nativeWf, 'stepped-run');
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, error, finished_at)
       VALUES (gen_random_uuid(), $1, 'say', 'say', 'action', 'error', 'reaped mid-step', now())`,
      [scoped],
    );
    const res = await fire().expect(409);
    expect(res.body.code).toBe('run_exists');
    expect(await workflowStatus(scoped)).toBeNull();
    expect(await runRow(scoped)).toMatchObject({ status: 'error' });
    expect(
      (await db.query(`SELECT node_id, status, error FROM runtime_run_steps WHERE run_id = $1`, [scoped]))
        .rows,
    ).toEqual([{ node_id: 'say', status: 'error', error: 'reaped mid-step' }]);
  });

  it("an id whose unstarted run is another workflow's is refused 409 run_exists, not re-armed", async () => {
    const { scoped, fire } = await reapedUnstarted(nativeWf, 'elsewhere-run');
    await db.query(`UPDATE runtime_runs SET workflow_id = $2 WHERE id = $1`, [scoped, stripeWf]);
    const res = await fire().expect(409);
    expect(res.body.code).toBe('run_exists');
    expect(await workflowStatus(scoped)).toBeNull();
    expect(await runRow(scoped)).toMatchObject({ status: 'error' });
    expect(await stepsOf(scoped)).toEqual([]);
  });

  it('a live run on the id of a dry run the reaper ended before its first step is refused 409 run_exists, and the row is left as it was', async () => {
    const ir = workflowDoc('dry, then live', { type: 'orchestr:webhook' });
    const scoped = `${MOCK_USER_ID}:dry-reaped`;
    const fire = (dryRun: boolean) =>
      http()
        .post('/api/runs/from-ir')
        .send({ workflow_ir: ir, workflow_id: nativeWf, run_id: 'dry-reaped', dry_run: dryRun });
    await fire(true).expect(201);
    // As a dry run whose service was killed before its first step leaves it, past the run's maximum duration.
    await db.query(`DELETE FROM runtime_run_steps WHERE run_id = $1`, [scoped]);
    await db.query(
      `UPDATE runtime_runs
          SET status = 'running', outputs = NULL, finished_at = NULL, started_at = now() - interval '61 minutes'
        WHERE id = $1`,
      [scoped],
    );
    expect((await app.get(RunReaperService).reapStale()).crashedRuns).toBe(1);
    const reaped = await wholeRow(scoped);
    expect(reaped).toMatchObject({ status: 'error', dry_run: true });

    const live = await fire(false).expect(409);
    expect(live.body.code).toBe('run_exists');
    expect(await wholeRow(scoped)).toEqual(reaped);
    expect(await workflowStatus(scoped)).toBeNull();
    expect(await stepsOf(scoped)).toEqual([]);
  });

  it('a live run on the id of a dry run still in flight is refused 409 run_exists, and starts no workflow beside it', async () => {
    const plan = {
      id: 'dry-in-flight',
      nodes: [{ kind: 'action', id: 'say', actionId: 'text.concat', props: { texts: ['x'], separator: '' } }],
    };
    const scoped = `${MOCK_USER_ID}:dry-in-flight`;
    const send = (dryRun: boolean) =>
      http()
        .post('/api/runs')
        .send({ plan, run_id: 'dry-in-flight', dry_run: dryRun })
        .then((res) => res);
    const hold = await holdInserts(
      process.env.DATABASE_URL!,
      'runtime_run_steps',
      db,
      'INSERT INTO runtime_run_steps',
    );
    let dry: Promise<request.Response>;
    let live: Promise<request.Response>;
    let answered: request.Response | null = null;
    try {
      dry = send(true);
      await hold.held();
      expect(await runRow(scoped)).toMatchObject({ status: 'running' });
      live = send(false);
      void live.then(
        (res) => (answered = res),
        () => undefined,
      );
      await eventually(
        'the live run answered, or a workflow started beside the dry run',
        async () => answered?.status ?? (await workflowStatus(scoped)),
        (seen) => seen !== null,
      );
    } finally {
      await hold.release();
    }
    const [dryRes, liveRes] = await Promise.all([dry, live]);
    expect(await workflowStatus(scoped)).toBeNull();
    expect([liveRes.status, liveRes.body.code]).toEqual([409, 'run_exists']);
    expect(dryRes.status).toBe(201);
    expect(await wholeRow(scoped)).toMatchObject({ status: 'completed', dry_run: true });
    expect(await stepsOf(scoped)).toEqual(['say']);
  });

  it('a registered SDK webhook resend whose run ended with no workflow acknowledges it, and saves its dedupe mark', async () => {
    const activation = await activationOf(stripeWf);
    await db.query(`INSERT INTO e2e_refused_marks VALUES ($1)`, [activation]);
    const runId = await stripeRunId('evt_mark_lost');
    const scoped = `${MOCK_USER_ID}:${runId}`;
    await sendStripe('evt_mark_lost').expect(500);
    await disarm();
    expect(await stored(activation, 'seen')).not.toEqual(expect.arrayContaining(['evt_mark_lost']));
    await workflowSucceeded(scoped);
    await dbos.query(`DELETE FROM dbos.workflow_status WHERE workflow_uuid = $1`, [scoped]);
    const runsBefore = (await runsOf(stripeWf)).length;

    const resend = await sendStripe('evt_mark_lost').expect(202);
    expect(resend.body).toMatchObject({ fired: 1, run_id: runId });
    expect(await stored(activation, 'seen')).toEqual(expect.arrayContaining(['evt_mark_lost']));
    expect(await runsOf(stripeWf)).toHaveLength(runsBefore);
    expect(await workflowStatus(scoped)).toBeNull();
    expect(await stepsOf(scoped)).toEqual(['say']);
    expect((await sendStripe('evt_mark_lost').expect(202)).body).toMatchObject({ fired: 0 });
  });

  it.each([
    ['another workflow', true],
    ['the same workflow', false],
  ])(
    'a live run on the id of a run of %s left waiting with no workflow is refused 409 run_exists, and the row is left as it was',
    async (_what, elsewhere) => {
      const { scoped, fire } = await reapedUnstarted(
        nativeWf,
        elsewhere ? 'waiting-elsewhere' : 'waiting-same',
      );
      await db.query(
        `UPDATE runtime_runs SET status = 'waiting', error = NULL, finished_at = NULL, workflow_id = $2 WHERE id = $1`,
        [scoped, elsewhere ? stripeWf : nativeWf],
      );
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, waiting_topic, waiting_since)
         VALUES (gen_random_uuid(), $1, 'approve', 'approve', 'waitForEvent', 'running', 'approve', now())`,
        [scoped],
      );
      const before = await wholeRow(scoped);
      const res = await fire();
      expect([res.status, res.body.code]).toEqual([409, 'run_exists']);
      expect(await workflowStatus(scoped)).toBeNull();
      expect(await wholeRow(scoped)).toEqual(before);
    },
  );

  it('every run an intake admitted has completed once the service has closed', async () => {
    await app.close();
    closed = true;
    const statuses = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM runtime_runs WHERE id = ANY ($1::text[])`,
      [admitted],
    );
    expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual(
      Object.fromEntries(admitted.map((id) => [id, 'completed'])),
    );
  }, 60_000);
});
