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
import { ReviewTestService } from '../src/reviews/review-test.service';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { RunsService } from '../src/runs/runs.service';
import { MAX_SUB_WORKFLOW_INVOCATIONS } from '../src/runtime/base-plan-interpreter';
import { eventTopicFor } from '../src/runtime/event-wait';
import { RunRecorderService } from '../src/runtime/run-recorder.service';
import type { ReviewTestSummary } from '../src/reviews/review-test.types';
import { BranchService } from '../src/workflows/branch.service';
import { VersionsWriteService } from '../src/workflows/versions-write.service';
import { WorkflowLifecycleService } from '../src/workflows/workflow-lifecycle.service';
import { listenOnLoopback } from './support/listen';
import { deferred, lockProbes, pause } from './support/lock-probes';
import { insertPersonalOrgs } from './support/personal-org';
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
  const orgless = randomUUID();
  const orglessKey = 'ork_e2e_orgless_cccccccccccccccccccccccc';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const as = (r: request.Test, org: string): request.Test =>
    r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', org);
  const asOrgless = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${orglessKey}`);

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

  const deploy = async (org: string, name: string, doc = webhookDoc(name)): Promise<string> => {
    const res = await as(http().post('/api/deploy'), org).send({ workflow_json: doc }).expect(201);
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

  const { gateEmits, holdQuery, lockWaiters, deadlocks, deadlocksSince } = lockProbes(
    () => app,
    () => db,
  );

  const runRecordedWithin = async (runId: string, ms: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await pause(25)) {
      const { rows } = await db.query(`SELECT 1 FROM runtime_runs WHERE run_id = $1`, [runId]);
      if (rows.length > 0) return true;
    }
    return false;
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
    await insertPersonalOrgs(db, { id: personal, userId: user, name: 'Lock Order' });
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'k', $2, $3, now())`,
      [user, hash(key), key.slice(0, 12)],
    );
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'org-less@e2e.local', 'No Org', now(), now())`,
      [orgless],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'k', $2, $3, now())`,
      [orgless, hash(orglessKey), orglessKey.slice(0, 12)],
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

  interface FireBeside {
    org: string;
    env: string;
    /** A second workflow promoted to the environment, the one the write un-promotes. */
    other: string;
  }

  it.each([
    [
      'a rename',
      'environment.renamed',
      async ({ org, env }: FireBeside): Promise<number> => {
        const asked = await as(http().patch(`/api/environments/${env}`), org)
          .send({ name: 'fire-b' })
          .expect(409);
        return statusOf(
          as(http().patch(`/api/environments/${env}`), org).send({
            name: 'fire-b',
            confirm_url_changes: asked.body.url_changes,
          }),
        );
      },
    ],
    [
      "an environment delete's un-promote",
      'workflow.unpromoted',
      ({ org, env }: FireBeside): Promise<number> => statusOf(removeEnv(org, env)),
    ],
    [
      'an un-promote',
      'workflow.unpromoted',
      ({ org, env, other }: FireBeside): Promise<number> =>
        statusOf(as(http().delete(`/api/workflows/${other}/pointers/${env}`), org)),
    ],
    [
      "a workflow delete's un-promote",
      'workflow.unpromoted',
      ({ org, other }: FireBeside): Promise<number> => statusOf(remove(org, other)),
    ],
  ])(
    '%s held mid-way does not hold up the run a webhook fire in that environment starts',
    async (_, event, write) => {
      const org = await workspace('Fire beside a write');
      const env = await createEnv(org, 'fire-a');
      const [fired, other] = [await deploy(org, 'fired'), await deploy(org, 'un-promoted')];
      for (const wfId of [fired, other]) {
        const [v1] = await versions(org, wfId);
        await promote(org, wfId, 'fire-a', v1!.id).expect(201);
      }
      const held = gateEmits(event);
      const before = await deadlocks();
      const writing = write({ org, env, other });
      try {
        await held.arrived(0);
        await expect(
          db.query(`SELECT 1 FROM environments WHERE id = $1 FOR UPDATE NOWAIT`, [env]),
        ).rejects.toMatchObject({ code: '55P03' });
        const run = await http().post(`/api/hooks/${fired}/fire-a`).send({ title: 'beside' }).expect(202);
        expect(await runRecordedWithin(run.body.run_id as string, 3_000)).toBe(true);
      } finally {
        held.restore();
      }
      expect(await writing).toBe(200);
      expect(await deadlocksSince(before)).toBe(0);
    },
  );

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

    const chargeTo = (root: string, callKey: string, lineage: string[] = []): Promise<boolean> =>
      app.get(RunRecorderService).chargeSubWorkflowCall(root, callKey, MAX_SUB_WORKFLOW_INVOCATIONS, lineage);
    const chargeKeys = async (root: string): Promise<string[]> =>
      (
        await db.query<{ call_key: string }>(
          `SELECT call_key FROM runtime_sub_workflow_charges WHERE root_run_id = $1 ORDER BY call_key`,
          [root],
        )
      ).rows.map((row) => row.call_key);
    const rootWrites = {
      charge: {
        sql: /INSERT INTO runtime_sub_workflow_charges/,
        write: (root: string) => chargeTo(root, `${root}|agent`),
        kept: (root: string) => [`${root}|agent`],
      },
      forget: {
        sql: /DELETE FROM runtime_sub_workflow_charges/,
        write: async (root: string) => {
          await chargeTo(root, `${root}/child|agent`, [`${root}/child`]);
          await app.get(RunRecorderService).forgetSubWorkflowCharges(root, `${root}/child`);
          return true;
        },
        kept: () => [],
      },
    };

    it.each([
      ['a sub-workflow charge', 'a workflow', 'charge', 'workflow'],
      ['a sub-workflow charge', 'an environment', 'charge', 'environment'],
      ["a called run's forget of its charges", 'a workflow', 'forget', 'workflow'],
      ["a called run's forget of its charges", 'an environment', 'forget', 'environment'],
    ] as const)(
      '%s held under its root’s lock finishes before %s delete, which then clears the run’s link',
      async (_, __, write, kind) => {
        const org = await workspace(`${write} then ${kind} delete`);
        const wfId = await deploy(org, `${write} under delete`);
        const env = kind === 'environment' ? await createEnv(org, `${write}-${suffix()}`) : undefined;
        const id = await parkRun(`held-${write}-${suffix()}`, {
          workflowId: wfId,
          environmentId: env,
          status: 'running',
          waits: [],
        });
        const held = holdQuery(rootWrites[write].sql);
        const before = await deadlocks();
        try {
          const writing = rootWrites[write].write(id);
          await held.arrived;
          const deleting = statusOf(env ? removeEnv(org, env) : remove(org, wfId));
          await lockWaiters(1);
          held.release();
          expect(await writing).toBe(true);
          expect(await deleting).toBe(200);
        } finally {
          held.restore();
        }
        expect(await chargeKeys(id)).toEqual(rootWrites[write].kept(id));
        expect(await runOf(id)).toMatchObject(env ? { environment_id: null } : { workflow_id: null });
        expect(await deadlocksSince(before)).toBe(0);
      },
    );

    it('a cancel waits on a sub-workflow charge held under its run’s lock, then cancels the run', async () => {
      const org = await workspace('Charge then cancel');
      const runId = `held-charge-cancel-${suffix()}`;
      const id = await parkRun(runId, { waits: [{ key: 'approve', topic: 'approval', due: OPEN }] });
      const held = holdQuery(rootWrites.charge.sql);
      const before = await deadlocks();
      try {
        const charging = chargeTo(id, `${id}|agent`);
        await held.arrived;
        const cancelling = statusOf(as(http().post(`/api/runs/${runId}/cancel`), org));
        await lockWaiters(1);
        held.release();
        expect(await charging).toBe(true);
        expect(await cancelling).toBe(200);
      } finally {
        held.restore();
      }
      expect((await runOf(id)).status).toBe('cancelled');
      expect(await chargeKeys(id)).toEqual([`${id}|agent`]);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a crashed-run pass waits on a sub-workflow charge held under its run’s lock, then reaps the run', async () => {
      const id = await parkRun(`held-charge-reap-${suffix()}`, { status: 'running', waits: [] });
      const held = holdQuery(rootWrites.charge.sql);
      const before = await deadlocks();
      try {
        const charging = chargeTo(id, `${id}|agent`);
        await held.arrived;
        const reaping = app.get(RunReaperService).reapStale();
        await lockWaiters(1);
        held.release();
        expect(await charging).toBe(true);
        expect((await reaping).crashedRuns).toBeGreaterThanOrEqual(1);
      } finally {
        held.restore();
      }
      expect((await runOf(id)).status).toBe('error');
      expect(await chargeKeys(id)).toEqual([`${id}|agent`]);
      expect(await deadlocksSince(before)).toBe(0);
    });

    const CHARGERS = 5;
    it(`${CHARGERS} charges from as many called runs, queued behind one held at its insert, allow exactly the one call the cap has left`, async () => {
      const root = await parkRun(`cap-root-${suffix()}`, { status: 'running', waits: [] });
      const callers: string[] = [];
      for (let i = 0; i < CHARGERS; i++) {
        callers.push(await parkRun(`cap-caller-${suffix()}`, { status: 'running', waits: [] }));
      }
      await db.query(
        `INSERT INTO runtime_sub_workflow_charges (root_run_id, call_key, allowed)
         SELECT $1, 'seeded|' || g, true FROM generate_series(1, $2::int) g`,
        [root, MAX_SUB_WORKFLOW_INVOCATIONS - 1],
      );
      const query = EntityManager.prototype.query;
      const opened = deferred();
      let inserted = 0;
      // Each charge's insert runs, then its transaction stays open until the gate opens.
      const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
        this: EntityManager,
        text: string,
        params?: Parameters<EntityManager['query']>[1],
      ) {
        const result: unknown = await query.call(this, text, params);
        if (rootWrites.charge.sql.test(text)) {
          inserted++;
          await opened.promise;
        }
        return result;
      });
      try {
        const charging = callers.map((caller) => chargeTo(root, `${caller}|agent`, [caller]));
        const queued = async (): Promise<boolean> => {
          const { rows } = await db.query(
            `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          return inserted === 1 && rows.length >= CHARGERS - 1;
        };
        for (let i = 0; i < 200 && inserted < CHARGERS && !(await queued()); i++) await pause(25);
        expect(inserted === CHARGERS || (await queued())).toBe(true);
        opened.resolve();
        expect((await Promise.all(charging)).filter(Boolean)).toHaveLength(1);
      } finally {
        opened.resolve();
        spy.mockRestore();
      }
      const { rows } = await db.query<{ allowed: number }>(
        `SELECT count(*)::int AS allowed FROM runtime_sub_workflow_charges WHERE root_run_id = $1 AND allowed`,
        [root],
      );
      expect(rows[0]!.allowed).toBe(MAX_SUB_WORKFLOW_INVOCATIONS);
    });
  });

  describe('a workflow delete and an environment delete over a run they share', () => {
    const shared = async (
      name: string,
    ): Promise<{
      org: string;
      wfId: string;
      env: string;
      envName: string;
      versionId: string;
      runId: string;
    }> => {
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
      return { org, wfId, env, envName, versionId: v1!.id, runId };
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

    const unlinked = {
      workflow_id: null,
      workflow_version_id: null,
      environment_id: null,
      status: 'completed',
    };
    const cleared = { workflow: false, environment: false, secrets: 0, run: unlinked };

    it('an environment delete holding its row when the workflow delete starts finishes first, and both delete', async () => {
      const { org, wfId, env, runId } = await shared('Env delete then workflow delete');
      const held = holdQuery(/DELETE FROM environments WHERE id/);
      const wfEmit = gateEmits('workflow.deleted');
      const before = await deadlocks();
      try {
        const envDeleting = statusOf(removeEnv(org, env));
        await held.arrived;
        await expect(lockedNow('environments', env)).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        const wfDeleting = statusOf(remove(org, wfId));
        await lockWaiters(1);
        held.release();
        expect(await envDeleting).toBe(200);
        await Promise.race([wfEmit.arrived(0), wfDeleting]);
        expect(await leftBehind(wfId, env, runId)).toMatchObject({ workflow: true, environment: false });
        wfEmit.release(0);
        expect(await wfDeleting).toBe(200);
      } finally {
        held.restore();
        wfEmit.restore();
      }
      expect(await leftBehind(wfId, env, runId)).toEqual(cleared);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a workflow delete held mid-cascade, past the run, when the environment delete starts finishes first, and both delete', async () => {
      const { org, wfId, env, versionId, runId } = await shared('Workflow delete then env delete');
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      const envEmit = gateEmits('environment.deleted');
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
        await Promise.race([envEmit.arrived(0), envDeleting]);
        expect(await leftBehind(wfId, env, runId)).toMatchObject({ workflow: false, environment: true });
        envEmit.release(0);
        expect(await envDeleting).toBe(200);
      } finally {
        envEmit.restore();
        await holder.end();
      }
      expect(await leftBehind(wfId, env, runId)).toEqual(cleared);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a workflow delete holding the environments its runs ran in lets a run, a promote and a rename in one go ahead', async () => {
      const { org, wfId, env, envName } = await shared('Writes beside a delete');
      const fired = await deploy(org, 'fired beside a delete');
      const [firedV1] = await versions(org, fired);
      await promote(org, fired, envName, firedV1!.id).expect(201);
      const promoted = await deploy(org, 'promoted beside a delete');
      const [promotedV1] = await versions(org, promoted);
      const renamed = `beside-${suffix()}`;
      const rename = (confirm: unknown = null): request.Test =>
        as(http().patch(`/api/environments/${env}`), org).send({
          name: renamed,
          ...(confirm ? { confirm_url_changes: confirm } : {}),
        });
      const within = <T>(work: PromiseLike<T>): Promise<T | 'blocked'> =>
        Promise.race([work, pause(3_000).then(() => 'blocked' as const)]);
      const held = holdQuery(/SET active_version_id = NULL, default_branch_id = NULL/);
      try {
        const deleting = statusOf(remove(org, wfId));
        await held.arrived;
        await expect(lockedNow('environments', env)).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        const run = await within(
          http()
            .post(`/api/hooks/${fired}/${envName}`)
            .send({ title: 'beside a delete' })
            .then((res) => String(res.body.run_id)),
        );
        const recorded = await runRecordedWithin(run, 3_000);
        const promoting = await within(statusOf(promote(org, promoted, envName, promotedV1!.id)));
        const asked = await within(rename().then((res) => res.body.url_changes as unknown));
        const renaming = asked === 'blocked' ? asked : await within(statusOf(rename(asked)));
        expect({ recorded, promoting, renaming }).toEqual({ recorded: true, promoting: 201, renaming: 200 });
        held.release();
        expect(await deleting).toBe(200);
      } finally {
        held.restore();
      }
    });

    const orglessCallee = async (name: string): Promise<{ calledId: string; versionId: string }> => {
      const called = await asOrgless(http().post('/api/deploy'))
        .send({ workflow_json: webhookDoc(name) })
        .expect(201);
      const calledId = called.body.workflow_id as string;
      const callee = await db.query(`SELECT org_id FROM workflows WHERE id = $1`, [calledId]);
      expect(callee.rows).toEqual([{ org_id: null }]);
      const listed = await asOrgless(http().get(`/api/workflows/${calledId}/versions`)).expect(200);
      const [v1] = listed.body.versions as Array<{ id: string }>;
      return { calledId, versionId: v1!.id };
    };

    const subWorkflowRun = async (
      callee: { calledId: string; versionId: string },
      org: string,
      env: { id: string; name: string },
    ): Promise<string> => {
      const runId = `${orgless}:called-${suffix()}`;
      await db.query(
        `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, finished_at, source,
                                   workflow_id, workflow_version_id, environment, environment_id, org_id)
         VALUES ($1, $1, $2, 'plan-called', 'completed', now(), now(), 'sub_workflow', $3, $4, $5, $6, $7)`,
        [runId, orgless, callee.calledId, callee.versionId, env.name, env.id, org],
      );
      return runId;
    };

    it("an org delete and the delete of an org-less workflow whose sub-workflow run ran in the org's environment both delete", async () => {
      const org = await workspace('Org delete beside a sub-workflow run');
      const envName = `called-${suffix()}`;
      const env = await createEnv(org, envName);
      const callee = await orglessCallee('org-less callee');
      const { calledId, versionId } = callee;
      const runId = await subWorkflowRun(callee, org, { id: env, name: envName });
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      const before = await deadlocks();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM workflow_versions WHERE id = $1 FOR KEY SHARE`, [versionId]);
        const wfDeleting = statusOf(asOrgless(http().delete(`/api/workflows/${calledId}`)));
        await lockWaiters(1);
        await expect(lockedNow('runtime_runs', runId)).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        const orgDeleting = statusOf(http().delete(`/api/orgs/${org}`).set('Authorization', `Bearer ${key}`));
        await lockWaiters(2);
        await holder.query('COMMIT');
        expect(await wfDeleting).toBe(200);
        expect(await orgDeleting).toBe(200);
      } finally {
        await holder.end();
      }
      expect(await leftBehind(calledId, env, runId)).toMatchObject({
        workflow: false,
        environment: false,
        run: unlinked,
      });
      expect(await deadlocksSince(before)).toBe(0);
    });

    interface ScanOrders {
      created: string[];
      byId: string[];
      byHeap: string[];
      byName: string[];
      byLookup: string[];
    }

    interface RunsInFour {
      org: string;
      envs: Array<{ id: string; name: string }>;
      callee: { calledId: string; versionId: string };
      runIds: string[];
    }

    // An org with four custom environments and an org-less callee with a sub-workflow run in each, retried with a fresh org until `fits` the orders each scan takes them in.
    const runsInFour = async (fits: (orders: ScanOrders) => boolean): Promise<RunsInFour> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const org = await workspace('Org delete beside sub-workflow runs in four environments');
        const envs: Array<{ id: string; name: string }> = [];
        for (let i = 0; i < 4; i++) {
          const name = `e${i}-${suffix()}`;
          envs.push({ id: await createEnv(org, name), name });
        }
        const callee = await orglessCallee('org-less callee in four environments');
        const runIds: string[] = [];
        for (const env of envs) runIds.push(await subWorkflowRun(callee, org, env));
        const created = envs.map((env) => env.id);
        const scans = await db.query<{ by_id: string[]; by_heap: string[]; by_name: string[] }>(
          `SELECT array_agg(id::text ORDER BY id) AS by_id, array_agg(id::text ORDER BY ctid) AS by_heap,
                  array_agg(id::text ORDER BY lower(name)) AS by_name
             FROM environments WHERE id = ANY($1::uuid[])`,
          [created],
        );
        const lookup = await db.query<{ id: string }>(
          `SELECT e.id FROM environments e
            WHERE e.id IN (SELECT r.environment_id FROM runtime_runs r WHERE r.workflow_id = $1)
              FOR KEY SHARE OF e`,
          [callee.calledId],
        );
        const { by_id: byId, by_heap: byHeap, by_name: byName } = scans.rows[0]!;
        const byLookup = lookup.rows.map((row) => row.id);
        if (fits({ created, byId, byHeap, byName, byLookup })) return { org, envs, callee, runIds };
      }
      throw new Error('no four environments in the scan orders this test needs');
    };

    const allUnlinked = async ({ callee, envs, runIds }: RunsInFour): Promise<unknown> =>
      (
        await db.query(
          `SELECT EXISTS (SELECT 1 FROM workflows WHERE id = $1) AS workflow,
                  (SELECT count(*)::int FROM environments WHERE id = ANY($2::uuid[])) AS environments,
                  (SELECT count(*)::int FROM runtime_runs
                    WHERE id = ANY($3::text[]) AND status = 'completed' AND workflow_id IS NULL
                      AND workflow_version_id IS NULL AND environment_id IS NULL) AS unlinked`,
          [callee.calledId, envs.map((env) => env.id), runIds],
        )
      ).rows[0];

    it("an org delete and the delete of an org-less workflow whose sub-workflow runs ran in four of the org's environments both delete, with the environment that delete locks first held", async () => {
      // No scan order but id order starts at the lowest id, so only id order on both sides keeps the deletes apart.
      const four = await runsInFour(
        ({ byId, byHeap, byName, byLookup }) => ![byHeap[0], byName[0], byLookup[0]].includes(byId[0]),
      );
      const { org, envs, callee } = four;
      const holders = await Promise.all(
        envs.map(async (env) => {
          const client = new Client({ connectionString: dbUrl });
          await client.connect();
          await client.query('BEGIN');
          await client.query(`SELECT 1 FROM environments WHERE id = $1 FOR UPDATE`, [env.id]);
          const { rows } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
          return { client, pid: rows[0]!.pid };
        }),
      );
      const before = await deadlocks();
      try {
        const wfDeleting = statusOf(asOrgless(http().delete(`/api/workflows/${callee.calledId}`)));
        await lockWaiters(1);
        const waiting = await db.query<{ blockers: number[] }>(
          `SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        expect(waiting.rows).toHaveLength(1);
        const first = holders.filter((h) => waiting.rows[0]!.blockers.includes(h.pid));
        expect(first).toHaveLength(1);
        for (const h of holders) if (h !== first[0]) await h.client.query('ROLLBACK');
        const orgDeleting = statusOf(http().delete(`/api/orgs/${org}`).set('Authorization', `Bearer ${key}`));
        await lockWaiters(2);
        await first[0]!.client.query('COMMIT');
        expect({ workflow: await wfDeleting, org: await orgDeleting }).toEqual({ workflow: 200, org: 200 });
      } finally {
        await Promise.all(holders.map((h) => h.client.end()));
      }
      expect(await allUnlinked(four)).toEqual({
        workflow: false,
        environments: 0,
        unlinked: four.runIds.length,
      });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it("an org delete and the delete of an org-less workflow whose sub-workflow runs ran in four of the org's environments both delete, with the org delete held on the second environment its cascade reaches, ahead of the lowest id", async () => {
      // The cascade reaches e0 then e1, by heap and by name, and the lowest id comes later, so the org delete is part-way through its environments when the workflow delete starts.
      const four = await runsInFour(
        ({ created, byId, byHeap, byName }) =>
          byHeap.join() === created.join() &&
          byName.join() === created.join() &&
          !created.slice(0, 2).includes(byId[0]!),
      );
      const { org, envs, callee } = four;
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      const before = await deadlocks();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM environments WHERE id = $1 FOR KEY SHARE`, [envs[1]!.id]);
        const { rows } = await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        const orgDeleting = statusOf(http().delete(`/api/orgs/${org}`).set('Authorization', `Bearer ${key}`));
        await lockWaiters(1);
        const wfDeleting = statusOf(asOrgless(http().delete(`/api/workflows/${callee.calledId}`)));
        await lockWaiters(2);
        const waiting = await db.query<{ pid: number; blockers: number[] }>(
          `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        const orgWait = waiting.rows.find((w) => w.blockers.includes(rows[0]!.pid));
        expect(waiting.rows.filter((w) => w !== orgWait).map((w) => w.blockers)).toEqual([[orgWait?.pid]]);
        await holder.query('COMMIT');
        expect({ workflow: await wfDeleting, org: await orgDeleting }).toEqual({ workflow: 200, org: 200 });
      } finally {
        await holder.end();
      }
      expect(await allUnlinked(four)).toEqual({
        workflow: false,
        environments: 0,
        unlinked: four.runIds.length,
      });
      expect(await deadlocksSince(before)).toBe(0);
    });
  });

  describe("an environment's row is locked before its pointers", () => {
    const manualDoc = (name: string): Record<string, unknown> => {
      const doc = webhookDoc(name);
      const [trigger] = doc.nodes as Array<Record<string, unknown>>;
      trigger!.node_type = 'orchestr:trigger';
      return doc;
    };

    interface Crossed {
      org: string;
      env: string;
      /** Its workflows in the order a rename updates their pointers; an un-promote of the environment deletes them in reverse. */
      order: string[];
    }

    const rolledBack = async (sql: string, params: unknown[]): Promise<string[]> => {
      await db.query('BEGIN');
      try {
        return (await db.query<{ workflow_id: string }>(sql, params)).rows.map((row) => row.workflow_id);
      } finally {
        await db.query('ROLLBACK');
      }
    };

    const renameOrder = (env: string, envName: string): Promise<string[]> =>
      rolledBack(
        `UPDATE workflow_env_pointers SET environment = $2 WHERE environment_id = $1 RETURNING workflow_id`,
        [env, envName],
      );

    const UNPROMOTE = `DELETE FROM workflow_env_pointers p USING workflows w
          WHERE w.id = p.workflow_id
            AND (p.environment_id = $1 OR (p.environment_id IS NULL AND lower(p.environment) = $2 AND w.org_id = $3))`;

    const unpromoteOrder = (org: string, env: string, envName: string): Promise<string[]> =>
      rolledBack(`${UNPROMOTE} RETURNING p.workflow_id`, [env, envName, org]);

    // The planner scans the workflows first only once it sees enough of them beside the pointers, so add workflows with no pointer until it does.
    const unpromoteScansWorkflows = async (org: string, env: string, envName: string): Promise<void> => {
      for (let round = 0; round < 20; round++) {
        await db.query('ANALYZE workflows, workflow_env_pointers');
        const plan = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${UNPROMOTE}`, [env, envName, org]);
        const scans = plan.rows.map((row) => /Scan (?:using \S+ )?on (\w+)/.exec(row['QUERY PLAN'])?.[1]);
        if (scans.find(Boolean) === 'workflows') return;
        await db.query(
          `INSERT INTO workflows (id, name) SELECT gen_random_uuid(), 'no pointer' FROM generate_series(1, 50)`,
        );
      }
      throw new Error("the un-promote's plan never scans the workflows first");
    };

    // Three of `renamed` that `unpromoted` holds in the reverse order, if any.
    const reversedThree = (renamed: string[], unpromoted: string[]): string[] | undefined => {
      const at = (id: string): number => unpromoted.indexOf(id);
      const threes = renamed.flatMap((a, i) =>
        renamed.slice(i + 1).flatMap((b, j) => renamed.slice(i + j + 2).map((c) => [a, b, c])),
      );
      return threes.find(([a, b, c]) => at(a!) > at(b!) && at(b!) > at(c!));
    };

    // An environment left with three workflows' pointers that its delete's un-promote, scanning the workflows, deletes in the reverse of a rename's order: six promoted in the reverse of their creation, three kept, retried with a fresh org if no three are reversed.
    const crossed = async (name: string): Promise<Crossed> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const org = await workspace(name);
        const envName = `crossed-${suffix()}`;
        const env = await createEnv(org, envName);
        const created: string[] = [];
        for (let i = 0; i < 6; i++)
          created.push(await deploy(org, `${name} ${i}`, manualDoc(`${name} ${i}`)));
        for (const wfId of [...created].reverse()) {
          const [v1] = await versions(org, wfId);
          await promote(org, wfId, envName, v1!.id).expect(201);
        }
        await unpromoteScansWorkflows(org, env, envName);
        const renamed = await renameOrder(env, envName);
        const three = reversedThree(renamed, await unpromoteOrder(org, env, envName));
        if (!three) continue;
        for (const wfId of renamed.filter((id) => !three.includes(id))) {
          await as(http().delete(`/api/workflows/${wfId}/pointers/${env}`), org).expect(200);
        }
        const order = await renameOrder(env, envName);
        const unpromoted = await unpromoteOrder(org, env, envName);
        if (order.join() === three.join() && unpromoted.join() === [...three].reverse().join()) {
          return { org, env, order };
        }
      }
      throw new Error(
        "no environment whose delete un-promotes three workflows in the reverse of a rename's order",
      );
    };

    // A client holding the pointer a rename and an un-promote of the environment both reach second.
    const holdMiddle = async ({ env, order }: Crossed): Promise<Client> => {
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM workflow_env_pointers WHERE workflow_id = $1 AND environment_id = $2 FOR NO KEY UPDATE`,
        [order[1], env],
      );
      return holder;
    };

    const rowWaits = async (): Promise<string[]> =>
      (
        await db.query<{ relation: string }>(
          `SELECT l.relation::regclass::text AS relation
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND l.locktype = 'tuple'
            ORDER BY 1`,
        )
      ).rows.map((row) => row.relation);

    const renameEnv = (org: string, env: string): Promise<number> =>
      statusOf(as(http().patch(`/api/environments/${env}`), org).send({ name: `renamed-${suffix()}` }));

    const pointersOn = async (env: string): Promise<number> =>
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM workflow_env_pointers WHERE environment_id = $1`,
          [env],
        )
      ).rows[0]!.n;

    const leftBehind = async ({ env, order }: Crossed): Promise<unknown> =>
      (
        await db.query(
          `SELECT EXISTS (SELECT 1 FROM environments WHERE id = $1) AS environment,
                  (SELECT count(*)::int FROM workflow_env_pointers
                    WHERE workflow_id = ANY($2::uuid[]) AND environment <> 'production') AS pointers,
                  (SELECT json_object_agg(type, n) FROM (
                     SELECT type, count(*)::int AS n FROM domain_events
                      WHERE subject_id = ANY($3::text[])
                        AND type IN ('environment.renamed', 'environment.deleted', 'workflow.unpromoted')
                      GROUP BY type) e) AS events`,
          [env, order, [env, ...order]],
        )
      ).rows[0];

    const bothLanded = {
      environment: false,
      pointers: 0,
      events: { 'environment.renamed': 1, 'environment.deleted': 1, 'workflow.unpromoted': 3 },
    };

    it('a rename holding the environment when its delete starts lands first, and the delete, waiting at the environment row, then un-promotes what it renamed', async () => {
      const crossing = await crossed('Rename then environment delete');
      const holder = await holdMiddle(crossing);
      const before = await deadlocks();
      try {
        const renaming = renameEnv(crossing.org, crossing.env);
        await lockWaiters(1);
        const deleting = statusOf(removeEnv(crossing.org, crossing.env));
        await lockWaiters(2);
        expect(await rowWaits()).toEqual(['environments', 'workflow_env_pointers']);
        await holder.query('COMMIT');
        expect({ rename: await renaming, delete: await deleting }).toEqual({ rename: 200, delete: 200 });
      } finally {
        await holder.end();
      }
      expect(await leftBehind(crossing)).toEqual(bothLanded);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('an environment delete un-promoting when a rename of it starts goes first, and the rename, waiting at the environment row, then lands before the delete removes it', async () => {
      const crossing = await crossed('Environment delete then rename');
      const holder = await holdMiddle(crossing);
      const before = await deadlocks();
      try {
        const deleting = statusOf(removeEnv(crossing.org, crossing.env));
        await lockWaiters(1);
        const renaming = renameEnv(crossing.org, crossing.env);
        await lockWaiters(2);
        expect(await rowWaits()).toEqual(['environments', 'workflow_env_pointers']);
        await holder.query('COMMIT');
        expect({ delete: await deleting, rename: await renaming }).toEqual({ delete: 200, rename: 200 });
      } finally {
        await holder.end();
      }
      expect(await leftBehind(crossing)).toEqual(bothLanded);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a promote holding the environment when its delete starts lands first, and the delete un-promotes it with the rest', async () => {
      const org = await workspace('Promote then environment delete');
      const envName = `promoted-${suffix()}`;
      const env = await createEnv(org, envName);
      const deployed = await as(http().post('/api/deploy'), org)
        .send({ workflow_json: manualDoc('promoted while deleted') })
        .expect(201);
      const wfId = deployed.body.workflow_id as string;
      const [v1] = await versions(org, wfId);
      const promoted = gateEmits('workflow.promoted');
      const before = await deadlocks();
      try {
        const promoting = statusOf(promote(org, wfId, envName, v1!.id));
        await promoted.arrived(0);
        const deleting = statusOf(removeEnv(org, env));
        await lockWaiters(1);
        promoted.release(0);
        expect({ promote: await promoting, delete: await deleting }).toEqual({ promote: 201, delete: 200 });
      } finally {
        promoted.restore();
      }
      const unpromotedThere = await db.query(
        `SELECT 1 FROM domain_events WHERE type = 'workflow.unpromoted' AND subject_id = $1 AND payload->>'environment' = $2`,
        [wfId, envName],
      );
      expect(unpromotedThere.rows).toHaveLength(1);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it.each([
      [
        'an un-promote',
        (org: string, wfId: string, env: string): request.Test =>
          as(http().delete(`/api/workflows/${wfId}/pointers/${env}`), org),
      ],
      ["a workflow delete's un-promote", (org: string, wfId: string): request.Test => remove(org, wfId)],
    ])(
      '%s holding the environment when a rename of it starts lands first, and the rename lists no URL for it',
      async (_, unpromote) => {
        const org = await workspace('Un-promote then rename');
        const envName = `unpromoted-${suffix()}`;
        const env = await createEnv(org, envName);
        const wfId = await deploy(org, 'un-promoted while renamed');
        const [v1] = await versions(org, wfId);
        await promote(org, wfId, envName, v1!.id).expect(201);
        const unpromoted = gateEmits('workflow.unpromoted');
        const before = await deadlocks();
        try {
          const unpromoting = statusOf(unpromote(org, wfId, env));
          await unpromoted.arrived(0);
          const renaming = renameEnv(org, env);
          await lockWaiters(1);
          expect(await rowWaits()).toEqual(['environments']);
          unpromoted.release(0);
          unpromoted.release(1);
          expect({ unpromote: await unpromoting, rename: await renaming }).toEqual({
            unpromote: 200,
            rename: 200,
          });
        } finally {
          unpromoted.restore();
        }
        expect(await pointersOn(env)).toBe(0);
        expect(await deadlocksSince(before)).toBe(0);
      },
    );
  });
});
