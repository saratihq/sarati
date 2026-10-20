import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';
import { EntityManager } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { NOT_RESUMABLE, RecoveryGuard } from '../src/dbos/recovery-guard';
import { EventsService, type DomainEventInput } from '../src/events/events.service';
import { ReviewTestService } from '../src/reviews/review-test.service';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { RunsService } from '../src/runs/runs.service';
import { eventTopicFor } from '../src/runtime/event-wait';
import { RunRecorderService } from '../src/runtime/run-recorder.service';
import type { ReviewTestSummary } from '../src/reviews/review-test.types';
import { BranchService } from '../src/workflows/branch.service';
import { VersionsWriteService } from '../src/workflows/versions-write.service';
import { WorkflowLifecycleService } from '../src/workflows/workflow-lifecycle.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const ROUNDS = 30;
const RACERS = 12;

function webhookDoc(name: string, echo = 'title', separator = ''): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When it happens',
        node_type: 'orchestr:webhook',
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
        parameters: { texts: ['fired: ', `{{trigger.${echo}}}`], separator },
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

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Counts each request's answers by status, so a failing race reports every unexpected one at once.
class Tally {
  private readonly counts = new Map<string, number>();

  add(request: string, statuses: number[]): void {
    for (const status of statuses) {
      const key = `${request} ${status}`;
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
  }

  failures(): Record<string, number> {
    return Object.fromEntries([...this.counts].filter(([key]) => Number(key.split(' ')[1]) >= 500));
  }

  outside(allowed: Record<string, number[]>): Record<string, number> {
    return Object.fromEntries(
      [...this.counts].filter(([key]) => {
        const [request, status] = key.split(' ');
        return !allowed[request!]?.includes(Number(status));
      }),
    );
  }
}

describe('every write under a workflow locks the workflow row first (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let dbUrl = '';

  const user = randomUUID();
  const personal = randomUUID();
  const key = 'ork_e2e_lockord_aaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const as = (r: request.Test, org: string): request.Test =>
    r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', org);

  const workspace = async (name: string): Promise<string> => {
    const created = await http()
      .post('/api/orgs')
      .set('Authorization', `Bearer ${key}`)
      .send({ name })
      .expect(201);
    return created.body.id as string;
  };

  const createEnv = async (org: string, name: string): Promise<string> => {
    const res = await as(http().post('/api/environments'), org).send({ name }).expect(201);
    return res.body.id as string;
  };

  const deploy = async (org: string, name: string): Promise<string> => {
    const res = await as(http().post('/api/deploy'), org)
      .send({ workflow_json: webhookDoc(name) })
      .expect(201);
    return res.body.workflow_id as string;
  };

  const versions = async (
    org: string,
    wfId: string,
  ): Promise<Array<{ id: string; version_number: number }>> => {
    const res = await as(http().get(`/api/workflows/${wfId}/versions`), org).expect(200);
    return res.body.versions as Array<{ id: string; version_number: number }>;
  };

  const commit = (org: string, wfId: string, base: string, branch = 'main'): request.Test =>
    as(http().post(`/api/workflows/${wfId}/commit`), org).send({
      workflow_ir: webhookDoc('locked', 'body'),
      branch,
      commit_message: `on ${branch}`,
      base_version_id: base,
    });

  const promote = (org: string, wfId: string, environment: string, versionId: string): request.Test =>
    as(http().post(`/api/workflows/${wfId}/promote`), org).send({ environment, version_id: versionId });

  const remove = (org: string, wfId: string): request.Test =>
    as(http().delete(`/api/workflows/${wfId}`), org);

  const removeEnv = (org: string, env: string): request.Test =>
    as(http().delete(`/api/environments/${env}`), org);

  const suffix = (): string => randomUUID().slice(0, 8);

  const statusOf = (r: request.Test): Promise<number> => r.then((res) => res.status);

  const deadlocks = async (): Promise<number> => {
    const { rows } = await db.query<{ deadlocks: string }>(
      `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`,
    );
    return Number(rows[0]!.deadlocks);
  };

  // A backend reports its counters once idle, at most a second later.
  const deadlocksSince = async (before: number): Promise<number> => {
    await pause(1_500);
    return (await deadlocks()) - before;
  };

  const runRecordedWithin = async (runId: string, ms: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await pause(25)) {
      const { rows } = await db.query(`SELECT 1 FROM runtime_runs WHERE run_id = $1`, [runId]);
      if (rows.length > 0) return true;
    }
    return false;
  };

  const lockWaiters = async (count: number): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows.length >= count) return;
      await pause(25);
    }
    throw new Error(`never saw ${count} lock waiter(s)`);
  };

  const workflowState = async (
    wfId: string,
  ): Promise<{ exists: boolean; pointers: number; activations: number }> => {
    const { rows } = await db.query<{ exists: boolean; pointers: number; activations: number }>(
      `SELECT EXISTS (SELECT 1 FROM workflows WHERE id = $1) AS exists,
              (SELECT count(*)::int FROM workflow_env_pointers WHERE workflow_id = $1) AS pointers,
              (SELECT count(*)::int FROM runtime_trigger_activations WHERE workflow_id = $1) AS activations`,
      [wfId],
    );
    return rows[0]!;
  };

  const productionVersion = async (wfId: string): Promise<{ alias: string; pointer: string }> => {
    const { rows } = await db.query<{ alias: string; pointer: string }>(
      `SELECT w.active_version_id AS alias, p.version_id AS pointer
         FROM workflows w JOIN workflow_env_pointers p ON p.workflow_id = w.id AND p.environment = 'production'
        WHERE w.id = $1`,
      [wfId],
    );
    return rows[0]!;
  };

  // Holds each transaction that emits `type` at that emit, the nth until `release(n)` or `restore()`.
  const gateEmits = (
    type: string,
  ): { arrived: (n: number) => Promise<void>; release: (n: number) => void; restore: () => void } => {
    const events = app.get(EventsService);
    const emit = events.emit.bind(events);
    const gates: Array<{ arrived: Deferred; released: Deferred }> = [];
    const nth = (n: number): { arrived: Deferred; released: Deferred } =>
      (gates[n] ??= { arrived: deferred(), released: deferred() });
    let seen = 0;
    const spy = jest.spyOn(events, 'emit').mockImplementation(async (em, event: DomainEventInput) => {
      if (event.type === type) {
        const gate = nth(seen++);
        gate.arrived.resolve();
        await gate.released.promise;
      }
      return emit(em, event);
    });
    return {
      arrived: (n) => nth(n).arrived.promise,
      release: (n) => nth(n).released.resolve(),
      restore: () => {
        for (const gate of gates) gate.released.resolve();
        spy.mockRestore();
      },
    };
  };

  // Holds each call of `method` at its entry until `release()` or `restore()`, then runs it.
  const holdCalls = <T extends object>(
    target: T,
    method: keyof T & string,
  ): { arrived: Promise<void>; release: () => void; restore: () => void } => {
    const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
    const arrived = deferred();
    const released = deferred();
    const spy = jest.spyOn(target, method as never).mockImplementation((async (...args: unknown[]) => {
      arrived.resolve();
      await released.promise;
      return original(...args);
    }) as never);
    return {
      arrived: arrived.promise,
      release: released.resolve,
      restore: () => {
        released.resolve();
        spy.mockRestore();
      },
    };
  };

  // Holds the first query whose SQL matches `sql` before it runs, until `release()` or `restore()`.
  const holdQuery = (sql: RegExp): { arrived: Promise<void>; release: () => void; restore: () => void } => {
    const query = EntityManager.prototype.query;
    const arrived = deferred();
    const released = deferred();
    let held = false;
    const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      text: string,
      params?: Parameters<EntityManager['query']>[1],
    ) {
      if (!held && sql.test(text)) {
        held = true;
        arrived.resolve();
        await released.promise;
      }
      return query.call(this, text, params);
    });
    return {
      arrived: arrived.promise,
      release: released.resolve,
      restore: () => {
        released.resolve();
        spy.mockRestore();
      },
    };
  };

  const productionOf = async (org: string): Promise<string> =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`,
        [org],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    dbUrl = e2eUrl;
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'lock-order@e2e.local', 'Lock Order', now(), now())`,
      [user],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Lock Order', true, now(), now())`,
      [personal],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [personal, user],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'k', $2, $3, now())`,
      [user, hash(key), key.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await pause(500);
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it(`a workflow delete racing ${RACERS} commits on ${RACERS} branches, ${ROUNDS} times over, never deadlocks or answers 500`, async () => {
    const org = await workspace('Delete vs commit');
    const before = await deadlocks();
    const tally = new Tally();
    for (let round = 0; round < ROUNDS; round++) {
      const wfId = await deploy(org, `commit race ${round}`);
      const [v1] = await versions(org, wfId);
      const branches = Array.from({ length: RACERS }, (_, i) => `b${i}`);
      for (const name of branches) {
        await as(http().post(`/api/workflows/${wfId}/branches`), org)
          .send({ name })
          .expect(201);
      }
      const deleting = pause(round % 6).then(() => statusOf(remove(org, wfId)));
      const commits = branches.map((name, i) =>
        pause(i * 2).then(() => statusOf(commit(org, wfId, v1!.id, name))),
      );
      const [deleted, ...committed] = await Promise.all([deleting, ...commits]);
      tally.add('delete', [deleted]);
      tally.add('commit', committed);
      if (deleted === 200)
        expect(await workflowState(wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    }
    expect(tally.outside({ delete: [200], commit: [201, 404] })).toEqual({});
    expect(await deadlocksSince(before)).toBe(0);
  }, 180_000);

  it(`a workflow delete racing ${RACERS} promotes, ${ROUNDS} times over, never deadlocks or answers 500`, async () => {
    const org = await workspace('Delete vs promote');
    const envs = Array.from({ length: RACERS }, (_, i) => `race-${i}`);
    for (const name of envs) await createEnv(org, name);
    const before = await deadlocks();
    const tally = new Tally();
    for (let round = 0; round < ROUNDS; round++) {
      const wfId = await deploy(org, `promote race ${round}`);
      const [v1] = await versions(org, wfId);
      const deleting = pause((round * 7) % 40).then(() => statusOf(remove(org, wfId)));
      const promotes = envs.map((env, i) =>
        pause(i * 10).then(() => statusOf(promote(org, wfId, env, v1!.id))),
      );
      const [deleted, ...promoted] = await Promise.all([deleting, ...promotes]);
      tally.add('delete', [deleted]);
      tally.add('promote', promoted);
      const state = await workflowState(wfId);
      if (deleted === 200) expect(state).toEqual({ exists: false, pointers: 0, activations: 0 });
      if (deleted === 409) expect(state.exists).toBe(true);
    }
    expect(tally.outside({ delete: [200, 409], promote: [201, 404] })).toEqual({});
    expect(await deadlocksSince(before)).toBe(0);
  }, 180_000);

  it('a commit holding its branch when a delete starts finishes first, and the delete then removes the workflow', async () => {
    const org = await workspace('Commit then delete');
    const wfId = await deploy(org, 'held commit');
    const [v1] = await versions(org, wfId);
    const held = holdCalls(app.get(VersionsWriteService), 'insertVersion');
    const before = await deadlocks();
    try {
      const committing = statusOf(commit(org, wfId, v1!.id));
      await held.arrived;
      const deleting = statusOf(remove(org, wfId));
      await lockWaiters(1);
      held.release();
      expect(await committing).toBe(201);
      expect(await deleting).toBe(200);
    } finally {
      held.restore();
    }
    expect(await workflowState(wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    expect(await deadlocksSince(before)).toBe(0);
  });

  it.each([
    ['promote', (org: string, wfId: string, v1: string) => promote(org, wfId, 'staging', v1)],
    [
      'publish',
      (org: string, wfId: string) => as(http().post(`/api/workflows/${wfId}/publish`), org).send({}),
    ],
    [
      'restore',
      (org: string, wfId: string) =>
        as(http().post(`/api/workflows/${wfId}/restore`), org).send({ version_number: 1 }),
    ],
    ['commit', (org: string, wfId: string, v1: string) => commit(org, wfId, v1)],
  ])('a %s arriving while a delete commits waits for it and answers 404', async (_, write) => {
    const org = await workspace('Write during delete');
    const wfId = await deploy(org, 'deleting');
    const [v1] = await versions(org, wfId);
    const deleted = gateEmits('workflow.deleted');
    const before = await deadlocks();
    try {
      const deleting = statusOf(remove(org, wfId));
      await deleted.arrived(0);
      const writing = statusOf(write(org, wfId, v1!.id));
      await lockWaiters(1);
      deleted.release(0);
      expect(await deleting).toBe(200);
      expect(await writing).toBe(404);
    } finally {
      deleted.restore();
    }
    expect(await workflowState(wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    expect(await deadlocksSince(before)).toBe(0);
  });

  it('a name save racing a publish leaves the published version live, so restoring the old one moves production back', async () => {
    const org = await workspace('Rename vs publish');
    const wfId = await deploy(org, 'renamed while publishing');
    const [v1] = await versions(org, wfId);
    await commit(org, wfId, v1!.id).expect(201);
    const [v2] = await versions(org, wfId);
    const held = holdCalls(app.get(WorkflowLifecycleService), 'saveWorkflowMeta');
    try {
      const saving = statusOf(as(http().put(`/api/workflows/${wfId}`), org).send({ name: 'renamed' }));
      await held.arrived;
      await as(http().post(`/api/workflows/${wfId}/publish`), org)
        .send({})
        .expect(201);
      held.release();
      expect(await saving).toBe(200);
    } finally {
      held.restore();
    }
    expect(await productionVersion(wfId)).toEqual({ alias: v2!.id, pointer: v2!.id });

    const restored = await as(http().post(`/api/workflows/${wfId}/restore`), org)
      .send({ version_number: 1 })
      .expect(201);
    expect(restored.body).toMatchObject({ status: 'restored', live_version: 1 });
    expect(await productionVersion(wfId)).toEqual({ alias: v1!.id, pointer: v1!.id });
  });

  it('a restore to the version a drifted alias still names moves the production pointer to it', async () => {
    const org = await workspace('Drifted alias');
    const wfId = await deploy(org, 'drifted');
    const [v1] = await versions(org, wfId);
    await commit(org, wfId, v1!.id).expect(201);
    await as(http().post(`/api/workflows/${wfId}/publish`), org)
      .send({})
      .expect(201);
    const [v2] = await versions(org, wfId);
    await db.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [wfId, v1!.id]);
    expect(await productionVersion(wfId)).toEqual({ alias: v1!.id, pointer: v2!.id });

    await as(http().post(`/api/workflows/${wfId}/restore`), org)
      .send({ version_number: 1 })
      .expect(201);

    expect(await productionVersion(wfId)).toEqual({ alias: v1!.id, pointer: v1!.id });
  });

  it('a promote by the name a rename just gave, overtaken by a second rename, lands on a new environment of that name', async () => {
    const org = await workspace('Rename twice');
    const env = await createEnv(org, 'pe-a');
    const wfId = await deploy(org, 'promoted by new name');
    const [v1] = await versions(org, wfId);
    const rename = (name: string): Promise<number> =>
      statusOf(as(http().patch(`/api/environments/${env}`), org).send({ name }));
    const renamed = gateEmits('environment.renamed');
    try {
      const first = rename('pe-b');
      await renamed.arrived(0);
      const promoting = statusOf(promote(org, wfId, 'pe-b', v1!.id));
      await lockWaiters(1);
      const second = rename('pe-c');
      await lockWaiters(2);
      renamed.release(0);
      await renamed.arrived(1);
      await lockWaiters(1);
      renamed.release(1);
      expect(await first).toBe(200);
      expect(await second).toBe(200);
      expect(await promoting).toBe(201);
    } finally {
      renamed.restore();
    }
    const { rows } = await db.query<{ id: string; name: string; pointed: boolean }>(
      `SELECT e.id, e.name,
              EXISTS (SELECT 1 FROM workflow_env_pointers p WHERE p.environment_id = e.id AND p.workflow_id = $2) AS pointed
         FROM environments e WHERE e.org_id = $1 AND e.name IN ('pe-b', 'pe-c') ORDER BY e.name`,
      [org, wfId],
    );
    expect(rows).toEqual([
      { id: expect.any(String), name: 'pe-b', pointed: true },
      { id: env, name: 'pe-c', pointed: false },
    ]);
    expect(rows[0]!.id).not.toBe(env);
  });

  it('a rename held mid-way does not hold up the run a webhook fire in that environment starts', async () => {
    const org = await workspace('Fire during rename');
    const env = await createEnv(org, 'fire-a');
    const wfId = await deploy(org, 'fired during rename');
    const [v1] = await versions(org, wfId);
    await promote(org, wfId, 'fire-a', v1!.id).expect(201);
    const asked = await as(http().patch(`/api/environments/${env}`), org)
      .send({ name: 'fire-b' })
      .expect(409);
    const renamed = gateEmits('environment.renamed');
    try {
      const renaming = statusOf(
        as(http().patch(`/api/environments/${env}`), org).send({
          name: 'fire-b',
          confirm_url_changes: asked.body.url_changes,
        }),
      );
      await renamed.arrived(0);
      const fired = await http()
        .post(`/api/hooks/${wfId}/fire-a`)
        .send({ title: 'during rename' })
        .expect(202);
      expect(await runRecordedWithin(fired.body.run_id as string, 3_000)).toBe(true);
      renamed.release(0);
      expect(await renaming).toBe(200);
    } finally {
      renamed.restore();
    }
  });

  it('a second pointer on one environment is refused by the database', async () => {
    const org = await workspace('One pointer per env');
    const env = await createEnv(org, 'only-one');
    const wfId = await deploy(org, 'one pointer');
    const [v1] = await versions(org, wfId);
    await promote(org, wfId, 'only-one', v1!.id).expect(201);
    await expect(
      db.query(
        `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, environment_id) VALUES ($1, 'only-one-old', $2, $3)`,
        [wfId, v1!.id, env],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_workflow_env_pointers_workflow_env' });
  });
  // Two branches off the deployed head, `feat` committed on, and main moved apart from it, so a merge lands a version.
  const diverged = async (
    org: string,
    name: string,
  ): Promise<{ wfId: string; v1: string; reviewId: string }> => {
    const wfId = await deploy(org, name);
    const [v1] = await versions(org, wfId);
    for (const branch of ['feat', 'side']) {
      await as(http().post(`/api/workflows/${wfId}/branches`), org)
        .send({ name: branch })
        .expect(201);
    }
    const commitDoc = (branch: string, doc: Record<string, unknown>): request.Test =>
      as(http().post(`/api/workflows/${wfId}/commit`), org).send({
        workflow_ir: doc,
        branch,
        commit_message: `on ${branch}`,
        base_version_id: v1!.id,
      });
    await commitDoc('feat', webhookDoc(name, 'body')).expect(201);
    await commitDoc('main', webhookDoc(name, 'title', ' ')).expect(201);
    const review = await as(http().post(`/api/workflows/${wfId}/reviews`), org)
      .send({ source_branch: 'feat', title: 'feat into main' })
      .expect(201);
    return { wfId, v1: v1!.id, reviewId: review.body.id as string };
  };

  const branchExists = async (wfId: string, name: string): Promise<boolean> =>
    (await db.query(`SELECT 1 FROM workflow_branches WHERE workflow_id = $1 AND name = $2`, [wfId, name]))
      .rows.length === 1;

  const pointerCount = async (wfId: string, environment: string): Promise<number> =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM workflow_env_pointers WHERE workflow_id = $1 AND environment = $2`,
          [wfId, environment],
        )
      ).rows[0]!.n,
    );

  const testSummary = (source: string, target: string): ReviewTestSummary =>
    ({
      verdict: 'green',
      tested_at: new Date().toISOString(),
      environment_id: null,
      source_version_id: source,
      target_version_id: target,
    }) as unknown as ReviewTestSummary;

  it.each([
    ['promote', 'first'],
    ['publish', 'production'],
  ])(
    'a second %s into an environment the workflow is not in waits for the first, still writing its pointer, and one pointer is left',
    async (move, environment) => {
      const org = await workspace(`First ${move}`);
      await createEnv(org, 'first');
      const wfId = await deploy(org, `first ${move}`);
      const [v1] = await versions(org, wfId);
      if (environment === 'production') {
        await as(http().delete(`/api/workflows/${wfId}/pointers/${await productionOf(org)}`), org).expect(
          200,
        );
      }
      const moving = (): Promise<number> =>
        move === 'promote'
          ? statusOf(promote(org, wfId, environment, v1!.id))
          : statusOf(as(http().post(`/api/workflows/${wfId}/publish`), org).send({}));
      const held = holdQuery(/INSERT INTO workflow_env_pointers/);
      const before = await deadlocks();
      try {
        const first = moving();
        await held.arrived;
        const second = moving();
        await lockWaiters(1);
        held.release();
        expect([await first, await second]).toEqual([201, 201]);
      } finally {
        held.restore();
      }
      expect(await pointerCount(wfId, environment)).toBe(1);
      expect(await deadlocksSince(before)).toBe(0);
    },
  );

  it('un-promoting production while a publish moves it: the publish waits, and neither deadlocks', async () => {
    const org = await workspace('Unpromote vs publish');
    const wfId = await deploy(org, 'unpromote vs publish');
    const [v1] = await versions(org, wfId);
    await commit(org, wfId, v1!.id).expect(201);
    const production = await productionOf(org);
    const held = holdQuery(/UPDATE workflows SET active_version_id = NULL/);
    const before = await deadlocks();
    try {
      const unpromoting = statusOf(as(http().delete(`/api/workflows/${wfId}/pointers/${production}`), org));
      await held.arrived;
      const publishing = statusOf(as(http().post(`/api/workflows/${wfId}/publish`), org).send({}));
      await lockWaiters(1);
      held.release();
      expect(await unpromoting).toBe(200);
      expect(await publishing).toBe(201);
    } finally {
      held.restore();
    }
    expect(await pointerCount(wfId, 'production')).toBe(1);
    expect(await deadlocksSince(before)).toBe(0);
  });

  it(`a workflow delete racing every write under it, ${ROUNDS} times over, never deadlocks or answers 500`, async () => {
    const org = await workspace('Delete vs every write');
    const sweepEnv = await createEnv(org, 'sweep');
    const before = await deadlocks();
    const tally = new Tally();
    for (let round = 0; round < ROUNDS; round++) {
      const s = await diverged(org, `sweep ${round}`);
      await promote(org, s.wfId, 'sweep', s.v1).expect(201);
      const wf = `/api/workflows/${s.wfId}`;
      const send = (r: request.Test, body: object = {}): Promise<number> => statusOf(as(r, org).send(body));
      const writers: Array<[string, () => Promise<number>]> = [
        ['meta', () => send(http().put(wf), { name: 'renamed' })],
        [
          'commit',
          () =>
            send(http().post(`${wf}/commit`), {
              workflow_ir: webhookDoc('sweep', 'body'),
              branch: 'side',
              base_version_id: s.v1,
            }),
        ],
        ['rollback', () => send(http().post(`${wf}/versions/1/rollback?branch=main`))],
        ['layout', () => send(http().patch(`${wf}/layout`), { positions: { trigger: { x: 5, y: 5 } } })],
        ['publish', () => send(http().post(`${wf}/publish`))],
        ['restore', () => send(http().post(`${wf}/restore`), { version_number: 1 })],
        ['promote', () => send(http().post(`${wf}/promote`), { environment: 'staging', version_id: s.v1 })],
        ['unpromote', () => statusOf(as(http().delete(`${wf}/pointers/${sweepEnv}`), org))],
        ['branch', () => send(http().post(`${wf}/branches`), { name: 'fresh' })],
        ['protect', () => send(http().patch(`${wf}/branches/side/protection`), { is_protected: true })],
        ['unbranch', () => statusOf(as(http().delete(`${wf}/branches/side`), org))],
        ['merge', () => send(http().post(`${wf}/branches/feat/merge`), { target_branch: 'main' })],
        ['update', () => send(http().post(`${wf}/branches/feat/update`), { from_branch: 'main' })],
        [
          'review',
          () => send(http().post(`${wf}/reviews`), { source_branch: 'side', title: 'side into main' }),
        ],
        ['comment', () => send(http().post(`${wf}/reviews/${s.reviewId}/comments`), { body: 'looks right' })],
        ['approve', () => send(http().post(`${wf}/reviews/${s.reviewId}/approve`), { decision: 'approved' })],
        ['review-merge', () => send(http().post(`${wf}/reviews/${s.reviewId}/merge`))],
        ['close', () => send(http().post(`${wf}/reviews/${s.reviewId}/close`))],
        [
          'secret',
          () => send(http().put(`${wf}/webhook-secret`), { node_id: 'trigger', secret: 'sweep-secret' }),
        ],
        ['unsecret', () => statusOf(as(http().delete(`${wf}/webhook-secret?node_id=trigger`), org))],
        [
          'test-result',
          () =>
            app
              .get(ReviewTestService)
              .storeTest(s.wfId, s.reviewId, testSummary(s.v1, s.v1))
              .then(
                () => 200,
                () => 500,
              ),
        ],
      ];
      const deleting = pause((round * 7) % 40).then(() => statusOf(remove(org, s.wfId)));
      const racing = writers.map(([name, write], i) =>
        pause(i * 3)
          .then(write)
          .then((status) => tally.add(name, [status])),
      );
      const [deleted] = await Promise.all([deleting, ...racing]);
      tally.add('delete', [deleted]);
      if (deleted === 200)
        expect(await workflowState(s.wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    }
    expect(tally.failures()).toEqual({});
    expect(await deadlocksSince(before)).toBe(0);
  }, 300_000);

  it('a merge holding both its branches when a workflow delete starts finishes, and the delete then removes the workflow', async () => {
    const org = await workspace('Merge then delete');
    const s = await diverged(org, 'held merge');
    const held = holdCalls(app.get(BranchService), 'findCommonAncestor');
    const before = await deadlocks();
    try {
      const merging = statusOf(
        as(http().post(`/api/workflows/${s.wfId}/branches/feat/update`), org).send({ from_branch: 'main' }),
      );
      await held.arrived;
      const deleting = statusOf(remove(org, s.wfId));
      await lockWaiters(1);
      held.release();
      expect(await merging).toBe(201);
      expect(await deleting).toBe(200);
    } finally {
      held.restore();
    }
    expect(await workflowState(s.wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    expect(await deadlocksSince(before)).toBe(0);
  });

  it('a review merge holding its review when a workflow delete starts finishes, and the delete then removes the workflow', async () => {
    const org = await workspace('Review merge then delete');
    const s = await diverged(org, 'held review merge');
    const held = holdCalls(app.get(BranchService), 'mergeBranchIn');
    const before = await deadlocks();
    try {
      const merging = statusOf(
        as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/merge`), org).send({}),
      );
      await held.arrived;
      const deleting = statusOf(remove(org, s.wfId));
      await lockWaiters(1);
      held.release();
      expect(await merging).toBe(201);
      expect(await deleting).toBe(200);
    } finally {
      held.restore();
    }
    expect(await workflowState(s.wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    expect(await deadlocksSince(before)).toBe(0);
  });

  it('a test result being stored when a workflow delete starts is stored first, and the delete then removes the workflow', async () => {
    const org = await workspace('Test result then delete');
    const s = await diverged(org, 'held test result');
    const blocker = new Client({ connectionString: dbUrl });
    await blocker.connect();
    const before = await deadlocks();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE review_test_results IN SHARE MODE');
      const storing = app
        .get(ReviewTestService)
        .storeTest(s.wfId, s.reviewId, testSummary(s.v1, s.v1))
        .then(() => 'stored');
      await lockWaiters(1);
      const deleting = statusOf(remove(org, s.wfId));
      await lockWaiters(2);
      await blocker.query('COMMIT');
      expect(await storing).toBe('stored');
      expect(await deleting).toBe(200);
    } finally {
      await blocker.end();
    }
    expect(await workflowState(s.wfId)).toEqual({ exists: false, pointers: 0, activations: 0 });
    expect(await deadlocksSince(before)).toBe(0);
  });

  it('deleting a branch while a commit to it is landing waits for the commit, then deletes the branch', async () => {
    const org = await workspace('Branch delete vs commit');
    const s = await diverged(org, 'branch delete vs commit');
    const featHead = (
      await db.query<{ head_version_id: string }>(
        `SELECT head_version_id FROM workflow_branches WHERE workflow_id = $1 AND name = 'feat'`,
        [s.wfId],
      )
    ).rows[0]!.head_version_id;
    const held = holdCalls(app.get(VersionsWriteService), 'insertVersion');
    const before = await deadlocks();
    try {
      const committing = statusOf(
        as(http().post(`/api/workflows/${s.wfId}/commit`), org).send({
          workflow_ir: webhookDoc('branch delete vs commit', 'body', '-'),
          branch: 'feat',
          base_version_id: featHead,
        }),
      );
      await held.arrived;
      const deleting = statusOf(as(http().delete(`/api/workflows/${s.wfId}/branches/feat`), org));
      await lockWaiters(1);
      held.release();
      expect(await committing).toBe(201);
      expect(await deleting).toBe(200);
    } finally {
      held.restore();
    }
    expect(await branchExists(s.wfId, 'feat')).toBe(false);
    expect(await deadlocksSince(before)).toBe(0);
  });

  it('deleting a branch while its review merges waits for the merge, then deletes the branch', async () => {
    const org = await workspace('Branch delete vs review merge');
    const s = await diverged(org, 'branch delete vs review merge');
    const held = holdCalls(app.get(BranchService), 'mergeBranchIn');
    const before = await deadlocks();
    try {
      const merging = statusOf(
        as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/merge`), org).send({}),
      );
      await held.arrived;
      const deleting = statusOf(as(http().delete(`/api/workflows/${s.wfId}/branches/feat`), org));
      await lockWaiters(1);
      held.release();
      expect(await merging).toBe(201);
      expect(await deleting).toBe(200);
    } finally {
      held.restore();
    }
    expect(await branchExists(s.wfId, 'feat')).toBe(false);
    expect(await deadlocksSince(before)).toBe(0);
  });

  it('protecting a branch while it is being deleted waits for the delete, then says the branch is gone', async () => {
    const org = await workspace('Protect vs branch delete');
    const s = await diverged(org, 'protect vs branch delete');
    const deleted = gateEmits('branch.deleted');
    try {
      const deleting = statusOf(as(http().delete(`/api/workflows/${s.wfId}/branches/side`), org));
      await deleted.arrived(0);
      const protecting = as(http().patch(`/api/workflows/${s.wfId}/branches/side/protection`), org)
        .send({ is_protected: true })
        .then((res) => res);
      await lockWaiters(1);
      deleted.release(0);
      expect(await deleting).toBe(200);
      const refused = await protecting;
      expect(refused.status).toBe(404);
      expect(refused.body.detail).toBe("Branch 'side' not found");
    } finally {
      deleted.restore();
    }
    expect(await branchExists(s.wfId, 'side')).toBe(false);
  });

  it.each([
    [
      'a comment on its review',
      (org: string, s: { wfId: string; reviewId: string }) =>
        as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/comments`), org).send({
          body: 'late',
        }),
      (s: { reviewId: string }) => `Review ${s.reviewId} not found`,
    ],
    [
      'a rollback onto it',
      (org: string, s: { wfId: string }) =>
        as(http().post(`/api/workflows/${s.wfId}/versions/1/rollback?branch=feat`), org).send({}),
      () => "Branch 'feat' not found",
    ],
    [
      'a layout save on it',
      (org: string, s: { wfId: string }) =>
        as(http().patch(`/api/workflows/${s.wfId}/layout`), org).send({
          branch: 'feat',
          positions: { trigger: { x: 7, y: 7 } },
        }),
      () => "Branch 'feat' not found",
    ],
    [
      'closing its review',
      (org: string, s: { wfId: string; reviewId: string }) =>
        as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/close`), org).send({}),
      (s: { reviewId: string }) => `Review ${s.reviewId} not found`,
    ],
  ])(
    '%s while the branch is being deleted waits for the delete, then answers 404',
    async (_, write, detail) => {
      const org = await workspace('Branch write vs branch delete');
      const s = await diverged(org, 'branch write vs branch delete');
      const deleted = gateEmits('branch.deleted');
      try {
        const deleting = statusOf(as(http().delete(`/api/workflows/${s.wfId}/branches/feat`), org));
        await deleted.arrived(0);
        const writing = write(org, s).then((res) => res);
        await lockWaiters(1);
        deleted.release(0);
        expect(await deleting).toBe(200);
        const refused = await writing;
        expect(refused.status).toBe(404);
        expect(refused.body.detail).toBe(detail(s));
      } finally {
        deleted.restore();
      }
    },
  );

  it.each(
    ['comments', 'approve', 'merge', 'close'].flatMap((action) =>
      ['not-a-uuid', 'a'.repeat(36), '-'.repeat(36)].map((id) => [action, id]),
    ),
  )('a review %s on the malformed review id %s answers 404', async (action, id) => {
    const org = await workspace('Malformed review id');
    const wfId = await deploy(org, 'malformed review id');
    const res = await as(http().post(`/api/workflows/${wfId}/reviews/${id}/${action}`), org)
      .send({ body: 'hello', decision: 'approved' })
      .expect(404);
    expect(res.body.detail).toBe(`Review ${id} not found`);
  });

  it('a layout save naming the empty branch saves to the default branch', async () => {
    const org = await workspace('Layout empty branch');
    const wfId = await deploy(org, 'layout empty branch');
    const saved = await as(http().patch(`/api/workflows/${wfId}/layout`), org)
      .send({ branch: '', positions: { trigger: { x: 3, y: 4 } } })
      .expect(200);
    expect(saved.body).toEqual({ updated: 1 });
  });

  it('a review merge refused because another write holds the review says so, with 409', async () => {
    const org = await workspace('Review busy');
    const s = await diverged(org, 'review busy');
    const closed = gateEmits('review.closed');
    try {
      const closing = statusOf(
        as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/close`), org).send({}),
      );
      await closed.arrived(0);
      const refused = await as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/merge`), org)
        .send({})
        .expect(409);
      expect(refused.body).toMatchObject({
        code: 'review_busy',
        detail: 'This review is being changed by someone else — retry shortly',
      });
      closed.release(0);
      expect(await closing).toBe(201);
    } finally {
      closed.restore();
    }
  });

  it('opening a review from a branch being deleted waits for the delete, then says the branch is gone', async () => {
    const org = await workspace('Review vs branch delete');
    const s = await diverged(org, 'review vs branch delete');
    await as(http().post(`/api/workflows/${s.wfId}/reviews/${s.reviewId}/close`), org)
      .send({})
      .expect(201);
    const deleted = gateEmits('branch.deleted');
    try {
      const deleting = statusOf(as(http().delete(`/api/workflows/${s.wfId}/branches/feat`), org));
      await deleted.arrived(0);
      const opening = as(http().post(`/api/workflows/${s.wfId}/reviews`), org)
        .send({ source_branch: 'feat', title: 'too late' })
        .then((res) => res);
      await lockWaiters(1);
      deleted.release(0);
      expect(await deleting).toBe(200);
      const refused = await opening;
      expect(refused.status).toBe(404);
      expect(refused.body.detail).toBe("Branch 'feat' not found");
    } finally {
      deleted.restore();
    }
  });

  it.each([
    [
      'set',
      (org: string, wfId: string) =>
        as(http().put(`/api/workflows/${wfId}/webhook-secret`), org).send({
          node_id: 'trigger',
          secret: 's',
        }),
    ],
    [
      'clear',
      (org: string, wfId: string) =>
        as(http().delete(`/api/workflows/${wfId}/webhook-secret?node_id=trigger`), org),
    ],
  ])(
    'a webhook secret %s arriving while a workflow delete commits waits for it and answers 404',
    async (_, write) => {
      const org = await workspace('Secret during delete');
      const wfId = await deploy(org, 'secret during delete');
      await as(http().put(`/api/workflows/${wfId}/webhook-secret`), org)
        .send({ node_id: 'trigger', secret: 'old' })
        .expect(200);
      const deleted = gateEmits('workflow.deleted');
      try {
        const deleting = statusOf(remove(org, wfId));
        await deleted.arrived(0);
        const writing = statusOf(write(org, wfId));
        await lockWaiters(1);
        deleted.release(0);
        expect(await deleting).toBe(200);
        expect(await writing).toBe(404);
      } finally {
        deleted.restore();
      }
    },
  );

  it('a webhook secret set in an environment being deleted waits for the delete and answers 404', async () => {
    const org = await workspace('Secret during env delete');
    const env = await createEnv(org, 'secret-env');
    const wfId = await deploy(org, 'secret during env delete');
    const deleted = gateEmits('environment.deleted');
    try {
      const deleting = statusOf(as(http().delete(`/api/environments/${env}`), org));
      await deleted.arrived(0);
      const writing = statusOf(
        as(http().put(`/api/workflows/${wfId}/webhook-secret`), org).send({
          node_id: 'trigger',
          secret: 's',
          environment: 'secret-env',
        }),
      );
      await lockWaiters(1);
      deleted.release(0);
      expect(await deleting).toBe(200);
      expect(await writing).toBe(404);
    } finally {
      deleted.restore();
    }
  });

  it('clearing a webhook secret says whether there was one', async () => {
    const org = await workspace('Secret clear');
    const wfId = await deploy(org, 'secret clear');
    const clear = (): request.Test =>
      as(http().delete(`/api/workflows/${wfId}/webhook-secret?node_id=trigger`), org);
    expect((await clear().expect(200)).body).toEqual({ status: 'absent' });
    await as(http().put(`/api/workflows/${wfId}/webhook-secret`), org)
      .send({ node_id: 'trigger', secret: 's' })
      .expect(200);
    expect((await clear().expect(200)).body).toEqual({ status: 'cleared' });
    expect((await clear().expect(200)).body).toEqual({ status: 'absent' });
  });

  describe("a run's own lock, taken first, under a workflow or environment delete", () => {
    const OPEN = `now() + interval '1 hour'`;
    const LAPSED = `now() - interval '2 hours'`;
    interface HeldWait {
      key: string;
      topic: string;
      due: string;
    }

    const parkRun = async (
      runId: string,
      own: { workflowId?: string; environmentId?: string; status?: string; waits: HeldWait[] },
    ): Promise<string> => {
      const id = `${user}:${runId}`;
      await db.query(
        `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, workflow_id, environment_id)
         VALUES ($1, $2, $3, 'plan-held', $4, now() - interval '3 hours', $5, $6)`,
        [id, runId, user, own.status ?? 'waiting', own.workflowId ?? null, own.environmentId ?? null],
      );
      for (const w of own.waits) {
        await db.query(
          `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at,
                                          waiting_topic, waiting_since, waiting_timeout_at)
           VALUES (gen_random_uuid(), $1, $2, $2, 'waitForEvent', 'running', now() - interval '3 hours',
                   $3, now() - interval '3 hours', ${w.due})`,
          [id, w.key, w.topic],
        );
      }
      return id;
    };
    const runOf = async (
      id: string,
    ): Promise<{ status: string; workflow_id: string | null; environment_id: string | null }> =>
      (
        await db.query<{ status: string; workflow_id: string | null; environment_id: string | null }>(
          `SELECT status, workflow_id, environment_id FROM runtime_runs WHERE id = $1`,
          [id],
        )
      ).rows[0]!;
    const decide = (org: string, runId: string, stepKey: string, topic: string): Promise<number> =>
      statusOf(
        as(http().post(`/api/runs/${runId}/events`), org).send({
          topic,
          step_key: stepKey,
          payload: { d: 1 },
        }),
      );

    let deliver: jest.SpyInstance;
    beforeEach(() => {
      // The decision is claimed for real; only its send to a run that is not executing is stood in for.
      deliver = jest.spyOn(app.get(RunsService), 'deliver' as never).mockResolvedValue(undefined as never);
    });
    afterEach(() => deliver.mockRestore());

    it.each([
      ['a workflow', 'workflow'],
      ['an environment', 'environment'],
    ])(
      'a decision held under its run lock finishes before %s delete, which then clears the run’s link',
      async (_, kind) => {
        const org = await workspace(`Claim then ${kind} delete`);
        const wfId = await deploy(org, 'claim under delete');
        const env = kind === 'environment' ? await createEnv(org, `claim-${suffix()}`) : undefined;
        const runId = `held-claim-${suffix()}`;
        const id = await parkRun(runId, {
          workflowId: wfId,
          environmentId: env,
          waits: [{ key: 'approve', topic: 'approval', due: OPEN }],
        });
        const held = holdQuery(/SET claimed_at = t\.at/);
        const before = await deadlocks();
        try {
          const deciding = decide(org, runId, 'approve', 'approval');
          await held.arrived;
          const deleting = statusOf(env ? removeEnv(org, env) : remove(org, wfId));
          await lockWaiters(1);
          held.release();
          expect(await deciding).toBe(200);
          expect(await deleting).toBe(200);
        } finally {
          held.restore();
        }
        expect(await runOf(id)).toMatchObject(env ? { environment_id: null } : { workflow_id: null });
        expect(await deadlocksSince(before)).toBe(0);
      },
    );

    it('a cancel held under its run lock finishes before a workflow delete', async () => {
      const org = await workspace('Cancel then delete');
      const wfId = await deploy(org, 'cancel under delete');
      const runId = `held-cancel-${suffix()}`;
      const id = await parkRun(runId, {
        workflowId: wfId,
        waits: [{ key: 'approve', topic: 'approval', due: OPEN }],
      });
      const held = holdQuery(/SET status = 'cancelled'/);
      const before = await deadlocks();
      try {
        const cancelling = statusOf(as(http().post(`/api/runs/${runId}/cancel`), org));
        await held.arrived;
        const deleting = statusOf(remove(org, wfId));
        await lockWaiters(1);
        held.release();
        expect(await cancelling).toBe(200);
        expect(await deleting).toBe(200);
      } finally {
        held.restore();
      }
      expect(await runOf(id)).toEqual({ status: 'cancelled', workflow_id: null, environment_id: null });
      expect(await deadlocksSince(before)).toBe(0);
    });

    const claimOn = (id: string, key: string, ago: string): Promise<unknown> =>
      db.query(
        `UPDATE runtime_run_steps SET claimed_at = date_trunc('milliseconds', now() - ${ago}::interval),
                                      claimed_by = $3, claimed_payload = '{"d":1}'
          WHERE run_id = $1 AND step_key = $2`,
        [id, key, user],
      );
    const creditOf = async (id: string): Promise<{ step: string | null; slot: string | null }> =>
      (
        await db.query<{ step: string | null; slot: string | null }>(
          `SELECT (SELECT string_agg(s.decided_by::text, ',') FROM runtime_run_steps s WHERE s.run_id = r.id) AS step,
                  r.decided_by AS slot
             FROM runtime_runs r WHERE r.id = $1`,
          [id],
        )
      ).rows[0]!;

    it.each([
      ['a workflow', 'workflow'],
      ['an environment', 'environment'],
    ])(
      'an answered resume held at its run update finishes before %s delete, keeping who decided',
      async (_, kind) => {
        const org = await workspace(`Resume then ${kind} delete`);
        const wfId = await deploy(org, 'resume under delete');
        const env = kind === 'environment' ? await createEnv(org, `resume-${suffix()}`) : undefined;
        const id = await parkRun(`held-resume-${suffix()}`, {
          workflowId: wfId,
          environmentId: env,
          waits: [{ key: 'approve', topic: 'approval', due: OPEN }],
        });
        await claimOn(id, 'approve', `'1 second'`);
        const held = holdQuery(/SET status = CASE WHEN EXISTS/);
        const before = await deadlocks();
        try {
          const resuming = app.get(RunRecorderService).stepResumed(id, 'approve', true);
          await held.arrived;
          const deleting = statusOf(env ? removeEnv(org, env) : remove(org, wfId));
          await lockWaiters(1);
          held.release();
          await resuming;
          expect(await deleting).toBe(200);
        } finally {
          held.restore();
        }
        expect(await creditOf(id)).toEqual({ step: user, slot: user });
        expect(await runOf(id)).toMatchObject(env ? { environment_id: null } : { workflow_id: null });
        expect(await deadlocksSince(before)).toBe(0);
      },
    );

    it('a stranded decision held at its run update finishes before a workflow delete, keeping who decided', async () => {
      const org = await workspace('Strand then delete');
      const wfId = await deploy(org, 'strand under delete');
      const id = await parkRun(`held-strand-${suffix()}`, {
        workflowId: wfId,
        waits: [{ key: 'approve', topic: 'approval', due: LAPSED }],
      });
      await claimOn(id, 'approve', `'150 minutes'`);
      const held = holdQuery(/SET status = 'error', finished_at = now\(\), error = \$4/);
      const before = await deadlocks();
      try {
        const reaping = app.get(RunReaperService).reapStale();
        await held.arrived;
        const deleting = statusOf(remove(org, wfId));
        await lockWaiters(1);
        held.release();
        expect((await reaping).strandedDecisions).toBeGreaterThanOrEqual(1);
        expect(await deleting).toBe(200);
      } finally {
        held.restore();
      }
      expect(await creditOf(id)).toEqual({ step: user, slot: user });
      expect(await runOf(id)).toMatchObject({ status: 'error', workflow_id: null });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it.each([
      ['a workflow', 'workflow'],
      ['an environment', 'environment'],
    ])(
      'a recovery the guard refuses, held at its run update, finishes before %s delete, keeping who decided',
      async (_, kind) => {
        const org = await workspace(`Refuse then ${kind} delete`);
        const wfId = await deploy(org, 'refuse under delete');
        const env = kind === 'environment' ? await createEnv(org, `refuse-${suffix()}`) : undefined;
        const id = await parkRun(`held-refuse-${suffix()}`, {
          workflowId: wfId,
          environmentId: env,
          waits: [{ key: 'approve', topic: 'approval', due: OPEN }],
        });
        await claimOn(id, 'approve', `'1 second'`);
        const guard = app.get(RecoveryGuard);
        // Only its read of the DBOS history is stood in for; the end it writes is the guard's own.
        const judged = jest
          .spyOn(guard as never, 'resumability')
          .mockResolvedValue({ resumable: false, cause: 'side-by-side', reason: 'held' } as never);
        const held = holdQuery(/SET status = 'error', error = \$2, finished_at = now\(\)/);
        const before = await deadlocks();
        try {
          const refusing = guard.admit(
            id,
            { plan: { id: 'plan-held', nodes: [] }, pins: {}, initialScope: {} },
            () => Promise.resolve(),
          );
          await held.arrived;
          const deleting = statusOf(env ? removeEnv(org, env) : remove(org, wfId));
          await lockWaiters(1);
          held.release();
          await expect(refusing).rejects.toThrow(NOT_RESUMABLE['side-by-side']);
          expect(await deleting).toBe(200);
        } finally {
          held.restore();
          judged.mockRestore();
        }
        expect(await creditOf(id)).toEqual({ step: user, slot: user });
        expect(await runOf(id)).toMatchObject({
          status: 'error',
          ...(env ? { environment_id: null } : { workflow_id: null }),
        });
        expect(await deadlocksSince(before)).toBe(0);
      },
    );

    it('a park held at its status re-derive finishes before a workflow delete', async () => {
      const org = await workspace('Park then delete');
      const wfId = await deploy(org, 'park under delete');
      const id = await parkRun(`held-park-${suffix()}`, { workflowId: wfId, status: 'running', waits: [] });
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at)
         VALUES (gen_random_uuid(), $1, 'approve', 'approve', 'waitForEvent', 'running', now())`,
        [id],
      );
      const held = holdQuery(/SET status = CASE WHEN EXISTS/);
      const before = await deadlocks();
      try {
        const parking = app.get(RunRecorderService).stepWaiting(id, 'approve', 'approval', 3_600_000);
        await held.arrived;
        const deleting = statusOf(remove(org, wfId));
        await lockWaiters(1);
        held.release();
        expect(await parking).toBeInstanceOf(Date);
        expect(await deleting).toBe(200);
      } finally {
        held.restore();
      }
      expect(await runOf(id)).toMatchObject({ status: 'waiting', workflow_id: null });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a reaper pass waits on a park held under its run lock, then reaps the lapsed wait', async () => {
      const id = await parkRun(`held-repark-${suffix()}`, {
        waits: [{ key: 'gone', topic: 'other', due: LAPSED }],
      });
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at)
         VALUES (gen_random_uuid(), $1, 'again', 'again', 'waitForEvent', 'running', now())`,
        [id],
      );
      const held = holdQuery(/SET status = CASE WHEN EXISTS/);
      const before = await deadlocks();
      try {
        const parking = app.get(RunRecorderService).stepWaiting(id, 'again', 'approval', 3_600_000);
        await held.arrived;
        const reaping = app.get(RunReaperService).reapStale();
        await lockWaiters(1);
        held.release();
        await parking;
        expect((await reaping).timedOutWaits).toBeGreaterThanOrEqual(1);
      } finally {
        held.restore();
      }
      expect((await runOf(id)).status).toBe('error');
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a crashed-run pass waits on a park held under its run lock, and the run it parks stays waiting', async () => {
      const id = await parkRun(`held-crashed-${suffix()}`, { status: 'running', waits: [] });
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at)
         VALUES (gen_random_uuid(), $1, 'again', 'again', 'waitForEvent', 'running', now())`,
        [id],
      );
      const held = holdQuery(/SET status = CASE WHEN EXISTS/);
      const before = await deadlocks();
      try {
        const parking = app
          .get(RunRecorderService)
          .stepWaiting(id, 'again', 'approval', 3_600_000, eventTopicFor('again'));
        await held.arrived;
        const reaping = app.get(RunReaperService).reapStale();
        await lockWaiters(1);
        held.release();
        expect(await parking).toBeInstanceOf(Date);
        await reaping;
      } finally {
        held.restore();
      }
      expect((await runOf(id)).status).toBe('waiting');
      const parked = await db.query<{ waiting_topic: string | null; delivery_topic: string | null }>(
        `SELECT waiting_topic, delivery_topic FROM runtime_run_steps WHERE run_id = $1`,
        [id],
      );
      expect(parked.rows).toEqual([{ waiting_topic: 'approval', delivery_topic: eventTopicFor('again') }]);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a decision claimed while the reaper waits on its run is kept, and the run is not reaped', async () => {
      const org = await workspace('Claim under reap');
      const runId = `held-reap-claim-${suffix()}`;
      const id = await parkRun(runId, {
        waits: [
          { key: 'gone', topic: 'other', due: LAPSED },
          { key: 'live', topic: 'approval', due: OPEN },
        ],
      });
      const held = holdQuery(/SET claimed_at = t\.at/);
      try {
        const deciding = decide(org, runId, 'live', 'approval');
        await held.arrived;
        const reaping = app.get(RunReaperService).reapStale();
        await lockWaiters(1);
        held.release();
        expect(await deciding).toBe(200);
        await reaping;
      } finally {
        held.restore();
      }
      expect((await runOf(id)).status).toBe('waiting');
      const steps = await db.query<{
        step_key: string;
        waiting_topic: string | null;
        claimed_by: string | null;
      }>(
        `SELECT step_key, waiting_topic, claimed_by FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
        [id],
      );
      expect(steps.rows).toEqual([
        { step_key: 'gone', waiting_topic: 'other', claimed_by: null },
        { step_key: 'live', waiting_topic: 'approval', claimed_by: user },
      ]);
    });

    it.each([
      ['a workflow', 'parked past their window', 'workflow', false],
      ['an environment', 'parked past their window', 'environment', false],
      ['a workflow', 'left running by a dead worker', 'workflow', true],
      ['an environment', 'left running by a dead worker', 'environment', true],
    ])(
      'the reaper and %s delete over two of its runs %s, locked in opposite orders by plan, never deadlock',
      async (_, __, kind, crashed) => {
        await db.query(
          `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at)
           SELECT 'filler-' || $2 || '-' || g, 'filler-' || $2 || '-' || g, $1, 'p', 'completed', now()
             FROM generate_series(1, 5000) g`,
          [user, suffix()],
        );
        await db.query('ANALYZE runtime_runs');
        await db.query('ANALYZE runtime_run_steps');
        const org = await workspace(`Reap under ${kind} delete`);
        const wfId = await deploy(org, 'reap under delete');
        const env = kind === 'environment' ? await createEnv(org, `reap-${suffix()}`) : undefined;
        const tag = suffix();
        const own = {
          workflowId: wfId,
          environmentId: env,
          status: crashed ? 'running' : 'waiting',
          waits: crashed ? [] : [{ key: 'approve', topic: 'approval', due: LAPSED }],
        };
        const last = await parkRun(`zz-zzzz-${tag}`, own);
        const first = await parkRun(`zz-aaaa-${tag}`, own);
        const holder = new Client({ connectionString: dbUrl });
        await holder.connect();
        const before = await deadlocks();
        try {
          await holder.query('BEGIN');
          await holder.query(`SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE`, [first]);
          const reaping = app.get(RunReaperService).reapStale();
          await lockWaiters(1);
          const deleting = statusOf(env ? removeEnv(org, env) : remove(org, wfId));
          await lockWaiters(2);
          await holder.query('COMMIT');
          await expect(reaping).resolves.toMatchObject(crashed ? { crashedRuns: 2 } : { timedOutWaits: 2 });
          expect(await deleting).toBe(200);
        } finally {
          await holder.end();
        }
        for (const id of [first, last]) expect((await runOf(id)).status).toBe('error');
        expect(await deadlocksSince(before)).toBe(0);
      },
    );
  });

  describe('a workflow delete and an environment delete over a run they share', () => {
    const shared = async (
      name: string,
    ): Promise<{ org: string; wfId: string; env: string; versionId: string; runId: string }> => {
      const org = await workspace(name);
      const wfId = await deploy(org, name);
      const envName = `shared-${suffix()}`;
      const env = await createEnv(org, envName);
      const [v1] = await versions(org, wfId);
      const runId = `${user}:shared-${suffix()}`;
      await db.query(
        `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, finished_at,
                                   workflow_id, workflow_version_id, environment, environment_id, org_id)
         VALUES ($1, $1, $2, 'plan-shared', 'completed', now(), now(), $3, $4, $5, $6, $7)`,
        [runId, user, wfId, v1!.id, envName, env, org],
      );
      await as(http().put(`/api/workflows/${wfId}/webhook-secret`), org)
        .send({ node_id: 'trigger', secret: 's', environment: envName })
        .expect(200);
      return { org, wfId, env, versionId: v1!.id, runId };
    };

    const leftBehind = async (wfId: string, env: string, runId: string): Promise<Record<string, unknown>> =>
      (
        await db.query(
          `SELECT EXISTS (SELECT 1 FROM workflows WHERE id = $1) AS workflow,
                  EXISTS (SELECT 1 FROM environments WHERE id = $2) AS environment,
                  (SELECT count(*)::int FROM webhook_trigger_secrets
                    WHERE workflow_id = $1 OR environment_id = $2) AS secrets,
                  (SELECT json_build_object('workflow_id', workflow_id, 'workflow_version_id', workflow_version_id,
                                            'environment_id', environment_id, 'status', status)
                     FROM runtime_runs WHERE id = $3) AS run`,
          [wfId, env, runId],
        )
      ).rows[0] as Record<string, unknown>;

    const LOCK_NOT_AVAILABLE = '55P03';
    const lockedNow = (table: 'environments' | 'runtime_runs', id: string): Promise<unknown> =>
      db.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);

    const cleared = {
      workflow: false,
      environment: false,
      secrets: 0,
      run: { workflow_id: null, workflow_version_id: null, environment_id: null, status: 'completed' },
    };

    it('an environment delete holding its row when the workflow delete starts finishes first, and both delete', async () => {
      const { org, wfId, env, runId } = await shared('Env delete then workflow delete');
      const held = holdQuery(/DELETE FROM environments WHERE id/);
      const before = await deadlocks();
      try {
        const envDeleting = statusOf(removeEnv(org, env));
        await held.arrived;
        await expect(lockedNow('environments', env)).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        const wfDeleting = statusOf(remove(org, wfId));
        await lockWaiters(1);
        held.release();
        expect(await envDeleting).toBe(200);
        expect(await wfDeleting).toBe(200);
      } finally {
        held.restore();
      }
      expect(await leftBehind(wfId, env, runId)).toEqual(cleared);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a workflow delete held mid-cascade, past the run, when the environment delete starts finishes first, and both delete', async () => {
      const { org, wfId, env, versionId, runId } = await shared('Workflow delete then env delete');
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      const before = await deadlocks();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM workflow_versions WHERE id = $1 FOR KEY SHARE`, [versionId]);
        const wfDeleting = statusOf(remove(org, wfId));
        await lockWaiters(1);
        await expect(lockedNow('runtime_runs', runId)).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        const envDeleting = statusOf(removeEnv(org, env));
        await lockWaiters(2);
        await holder.query('COMMIT');
        expect(await wfDeleting).toBe(200);
        expect(await envDeleting).toBe(200);
      } finally {
        await holder.end();
      }
      expect(await leftBehind(wfId, env, runId)).toEqual(cleared);
      expect(await deadlocksSince(before)).toBe(0);
    });
  });
});
