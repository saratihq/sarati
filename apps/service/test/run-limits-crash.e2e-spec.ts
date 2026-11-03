import { Client } from 'pg';

import { ir, irNode } from './support/golden-docs';
import { callStep, chain, edgeOn, HitFixture, MOCK_USER_ID, until } from './support/limits-fixture';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase, withDatabase } from './support/test-db';

const INTERRUPTED =
  'The service restarted while this run was going, and nothing can resume it: it ran only inside the service (a dry run, or with DBOS off), its start was never saved to DBOS, or DBOS is off now. Run it again.';
const DBOS_OFF = { DBOS_ENABLED: 'false' };
const LOCK_RUN = 'SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE';

/** A run's budget across a crash: its count lives on its root's row and its limits in its workflow's arguments (child processes, DBOS on, mock auth). */
describe('run limits across a crash (e2e, DBOS on)', () => {
  const fixture = new HitFixture();

  beforeAll(() => fixture.listen());
  afterAll(() => fixture.close());

  async function stack(env: Record<string, string>) {
    const databaseUrl = await createE2eDatabase(ADMIN_URL);
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    return { databaseUrl, db, service: await bootService({ service: THIS_SERVICE, databaseUrl, env }) };
  }

  const post = (service: ServiceProcess, path: string, body: unknown) =>
    fetch(`${service.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const start = (service: ServiceProcess, runId: string, ids: string[]) =>
    post(service, '/api/runs/async', {
      run_id: runId,
      workflow_ir: ir(
        ids.map((id) => callStep(fixture.base, id)),
        chain(ids),
      ),
    });

  const dryRun = (service: ServiceProcess, runId: string, step: string) =>
    post(service, '/api/runs/from-ir', {
      run_id: runId,
      dry_run: true,
      workflow_ir: ir([callStep(fixture.base, step)], []),
    });

  const callWorkflow = (workflowId: string) =>
    irNode('call', 'orchestr:call_workflow', { workflow_id: workflowId });

  const deployCallable = async (service: ServiceProcess, name: string, step: ReturnType<typeof irNode>) => {
    const deployed = await post(service, '/api/deploy', {
      workflow_json: {
        ...ir(
          [
            irNode('trigger', 'orchestr:tool_trigger', {
              tool_name: name,
              description: 'one step',
              inputs: [],
            }),
            step,
          ],
          [edgeOn('trigger', step.id)],
        ),
        name,
      },
    });
    expect(deployed.status).toBe(201);
    return ((await deployed.json()) as { workflow_id: string }).workflow_id;
  };

  const ended = async (db: Client, runId: string) => {
    let row: { status: string; error: string | null; steps_used: number } | undefined;
    await until(
      async () => {
        row = (
          await db.query<{ status: string; error: string | null; steps_used: number }>(
            `SELECT status, error, steps_used FROM runtime_runs WHERE id = $1`,
            [`${MOCK_USER_ID}:${runId}`],
          )
        ).rows[0];
        return row !== undefined && !['running', 'waiting'].includes(row.status);
      },
      `${runId} ended`,
      2_400,
    );
    return row!;
  };

  const states = async (db: Client, ids: string[]) =>
    (
      await db.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM runtime_runs WHERE id = ANY($1) ORDER BY array_position($1, id)`,
        [ids],
      )
    ).rows;

  const lockWaits = async (db: Client) =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
      ).rows[0]!.n,
    );

  it('a run recovered after a crash keeps counting from the steps it took before it: the fixture sees exactly RUN_MAX_STEPS calls in all, the one re-run after the crash included', async () => {
    const env = { RUN_MAX_STEPS: '5' };
    const { databaseUrl, db, service } = await stack(env);
    let current = service;
    try {
      const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
      fixture.hold('/c4');
      expect((await start(current, 'counted', ids)).status).toBe(201);
      await fixture.untilHit('/c4');
      await current.crash();
      fixture.release('/c4');
      current = await bootService({ service: THIS_SERVICE, databaseUrl, env });

      const row = await ended(db, 'counted');

      expect(ids.map((id) => fixture.count(`/${id}`))).toEqual([1, 1, 1, 2, 0, 0, 0]);
      expect(row).toMatchObject({ status: 'error', steps_used: 5 });
      expect(row.error).toMatch(/^Run limit reached: this run took 5 steps/);
    } finally {
      await current.crash();
      await db.end();
    }
  }, 180_000);

  it('time the service is down never counts as in flight: a run recovered after downtime past its time limit goes on from the step it was in', async () => {
    const env = { RUN_MAX_ACTIVE_SECONDS: '10', RUN_MAX_STEPS: '0' };
    const { databaseUrl, db, service } = await stack(env);
    let current = service;
    try {
      const ids = ['d1', 'd2'];
      fixture.hold('/d1');
      expect((await start(current, 'down', ids)).status).toBe(201);
      await fixture.untilHit('/d1');
      await current.crash();
      fixture.release('/d1');
      // Down longer than the run may stay in flight, by the database's own clock.
      await until(
        async () =>
          (
            await db.query<{ over: boolean }>(
              `SELECT started_at < now() - interval '12 seconds' AS over FROM runtime_runs WHERE id = $1`,
              [`${MOCK_USER_ID}:down`],
            )
          ).rows[0]?.over === true,
        'the run started 12 s ago',
        1_200,
      );
      current = await bootService({ service: THIS_SERVICE, databaseUrl, env });

      const row = await ended(db, 'down');

      expect(row).toMatchObject({ status: 'completed', error: null });
      expect(ids.map((id) => fixture.count(`/${id}`))).toEqual([2, 1]);
    } finally {
      await current.crash();
      await db.end();
    }
  }, 180_000);

  it('a run keeps the limits it was admitted under after a restart with lower ones', async () => {
    const { databaseUrl, db, service } = await stack({ RUN_MAX_STEPS: '10' });
    let current = service;
    try {
      const ids = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
      fixture.hold('/k2');
      expect((await start(current, 'kept', ids)).status).toBe(201);
      await fixture.untilHit('/k2');
      await current.crash();
      fixture.release('/k2');
      current = await bootService({ service: THIS_SERVICE, databaseUrl, env: { RUN_MAX_STEPS: '3' } });

      const row = await ended(db, 'kept');

      expect(row).toMatchObject({ status: 'completed', error: null, steps_used: 7 });
      expect(ids.map((id) => fixture.count(`/${id}`))).toEqual([1, 2, 1, 1, 1, 1]);
      // A run admitted after the restart runs under the new number.
      expect((await start(current, 'after-restart', ['n1', 'n2', 'n3', 'n4'])).status).toBe(201);
      expect(await ended(db, 'after-restart')).toMatchObject({ status: 'error', steps_used: 3 });
    } finally {
      await current.crash();
      await db.end();
    }
  }, 180_000);

  it.each([
    ['a dry run', 'cut-dry', {}, {}, true],
    ['a run while DBOS is off', 'cut-off', DBOS_OFF, DBOS_OFF, false],
    ['a run while DBOS was off, the service starting again with it on,', 'cut-was-off', DBOS_OFF, {}, false],
  ])(
    '%s a crash cut off mid-step is ended as the service starts again, so it holds none of its workspace’s slots',
    async (_kind, runId, before, after, dryRun) => {
      const room = { WORKSPACE_MAX_RUNNING_RUNS: '1' };
      const { databaseUrl, db, service } = await stack({ ...room, ...before });
      let current = service;
      const runIn = (svc: ServiceProcess, id: string) =>
        post(svc, '/api/runs/from-ir', {
          run_id: id,
          dry_run: dryRun,
          workflow_ir: ir([callStep(fixture.base, id)], []),
        });
      try {
        fixture.hold(`/${runId}`);
        void runIn(current, runId).catch(() => undefined);
        await fixture.untilHit(`/${runId}`);
        await current.crash();
        fixture.release(`/${runId}`);
        current = await bootService({ service: THIS_SERVICE, databaseUrl, env: { ...room, ...after } });

        expect(await ended(db, runId)).toMatchObject({ status: 'error', error: INTERRUPTED });
        const open = await db.query(
          `SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND finished_at IS NULL`,
          [`${MOCK_USER_ID}:${runId}`],
        );
        expect(open.rowCount).toBe(0);
        expect((await runIn(current, `${runId}-next`)).status).toBe(201);
      } finally {
        await current.crash();
        await db.end();
      }
    },
    180_000,
  );

  it('a restart with DBOS off ends a run called by one that left no row, and credits a decision on its way to a run it ends to whoever made it', async () => {
    const { databaseUrl, db, service } = await stack(DBOS_OFF);
    let current = service;
    const decided = `${MOCK_USER_ID}:decided`;
    const holder = new Client({ connectionString: databaseUrl });
    const queued = new Client({ connectionString: databaseUrl });
    await holder.connect();
    await queued.connect();
    try {
      // A caller with no workspace, so a test step's call reaches the workflow the caller owns outside any.
      expect((await fetch(`${current.base}/api/runs/waiting`)).status).toBe(200);
      await db.query(`DELETE FROM organizations WHERE personal_owner_id = $1`, [MOCK_USER_ID]);
      const orphaned = await deployCallable(current, 'orphaned', callStep(fixture.base, 'orphan1'));
      fixture.hold('/orphan1');
      void post(current, '/api/runs/test-step', { node: callWorkflow(orphaned) }).catch(() => undefined);
      await fixture.untilHit('/orphan1');
      const [orphan] = (
        await db.query<{ id: string }>(
          `SELECT id FROM runtime_runs r WHERE source = 'sub_workflow'
              AND NOT EXISTS (SELECT 1 FROM runtime_runs p WHERE p.id = r.parent_run_id)`,
        )
      ).rows;
      expect(orphan).toBeDefined();

      const approval = { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 600_000 };
      void post(current, '/api/runs', {
        run_id: 'decided',
        plan: { id: 'decided', nodes: [approval] },
      }).catch(() => undefined);
      await until(
        async () =>
          (
            await db.query(
              `SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND waiting_topic IS NOT NULL AND finished_at IS NULL`,
              [decided],
            )
          ).rowCount === 1,
        'the run parked on its approval',
      );
      // The decision's claim commits; the run's taking it waits behind a lock queued after the decision's until the process is gone.
      await holder.query('BEGIN');
      await holder.query(LOCK_RUN, [decided]);
      const decision = post(current, '/api/runs/decided/events', {
        topic: 'approval',
        payload: { d: 'yes' },
      });
      await until(async () => (await lockWaits(db)) === 1, 'the decision waiting on the run');
      await queued.query('BEGIN');
      const next = queued.query(LOCK_RUN, [decided]);
      await until(async () => (await lockWaits(db)) === 2, 'a lock queued behind the decision');
      await holder.query('COMMIT');
      await next;
      expect((await decision).status).toBe(200);
      await until(async () => (await lockWaits(db)) === 1, 'the run waiting to take the decision');
      await current.crash();
      await db.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      await queued.query('ROLLBACK');
      fixture.release('/orphan1');
      current = await bootService({ service: THIS_SERVICE, databaseUrl, env: DBOS_OFF });

      expect(await ended(db, 'decided')).toMatchObject({ status: 'error', error: INTERRUPTED });
      expect((await db.query(`SELECT decided_by FROM runtime_runs WHERE id = $1`, [decided])).rows).toEqual([
        { decided_by: MOCK_USER_ID },
      ]);
      expect(
        (
          await db.query(
            `SELECT step_key, status, decided_by, claimed_by, waiting_topic FROM runtime_run_steps WHERE run_id = $1`,
            [decided],
          )
        ).rows,
      ).toEqual([
        {
          step_key: 'approve',
          status: 'error',
          decided_by: MOCK_USER_ID,
          claimed_by: null,
          waiting_topic: null,
        },
      ]);
      await until(
        async () => (await states(db, [orphan!.id]))[0]?.status !== 'running',
        'the run called by one that left no row ended',
        2_400,
      );
      expect(await states(db, [orphan!.id])).toEqual([{ status: 'error', error: INTERRUPTED }]);
      const open = await db.query(
        `SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND finished_at IS NULL`,
        [orphan!.id],
      );
      expect(open.rowCount).toBe(0);
    } finally {
      await holder.end();
      await queued.end();
      await current.crash();
      await db.end();
    }
  }, 180_000);

  it('the pass a restart makes ends only runs nothing can resume: a durable run it finds in flight, and the workflows one is calling, are left for DBOS to finish, one whose caller lost its row included', async () => {
    const { databaseUrl, db, service } = await stack({});
    let current = service;
    const root = new Client({ connectionString: databaseUrl });
    await root.connect();
    try {
      const leaf = await deployCallable(current, 'leaf', callStep(fixture.base, 'leaf1'));
      const middle = await deployCallable(current, 'middle', callWorkflow(leaf));
      fixture.hold('/durable1');
      fixture.hold('/leaf1');
      fixture.hold('/zzdry');
      expect((await start(current, 'durable', ['durable1', 'durable2'])).status).toBe(201);
      for (const runId of ['calls', 'calls-lost']) {
        const caller = await post(current, '/api/runs/async', {
          run_id: runId,
          workflow_ir: ir([callWorkflow(middle)], []),
        });
        expect(caller.status).toBe(201);
      }
      void dryRun(current, 'zz-dry', 'zzdry').catch(() => undefined);
      await fixture.untilHit('/durable1');
      await fixture.untilHit('/leaf1', 2);
      await fixture.untilHit('/zzdry');
      await current.crash();
      fixture.release('/zzdry');
      const calledUnder = async (runId: string) =>
        (
          await db.query<{ id: string }>(
            `WITH RECURSIVE tree(id, depth) AS (
               SELECT id, 0 FROM runtime_runs WHERE id = $1
               UNION ALL
               SELECT r.id, t.depth + 1 FROM runtime_runs r JOIN tree t ON r.parent_run_id = t.id
             )
             SELECT id FROM tree WHERE depth > 0 ORDER BY depth`,
            [`${MOCK_USER_ID}:${runId}`],
          )
        ).rows.map((row) => row.id);
      const [middle1, leaf1] = await calledUnder('calls');
      const [middle2, leaf2] = await calledUnder('calls-lost');
      // As a called run's record, written best-effort, can be missing; its caller held as it comes back, so nothing records it again before the pass.
      await db.query(`DELETE FROM runtime_runs WHERE id = $1`, [middle2]);
      await root.query('BEGIN');
      await root.query(LOCK_RUN, [`${MOCK_USER_ID}:calls-lost`]);
      current = await bootService({ service: THIS_SERVICE, databaseUrl });

      // The pass takes runs in id order, so once it has ended the dry run it has passed the durable ones and the runs called.
      expect(await ended(db, 'zz-dry')).toMatchObject({ status: 'error', error: INTERRUPTED });
      expect(await states(db, [middle1!, leaf1!, leaf2!])).toEqual([
        { status: 'running', error: null },
        { status: 'running', error: null },
        { status: 'running', error: null },
      ]);
      await root.query('COMMIT');
      fixture.release('/durable1');
      fixture.release('/leaf1');

      expect(await ended(db, 'durable')).toMatchObject({ status: 'completed', error: null });
      expect(['durable1', 'durable2'].map((id) => fixture.count(`/${id}`))).toEqual([2, 1]);
      expect(await ended(db, 'calls')).toMatchObject({ status: 'completed', error: null });
      expect(await ended(db, 'calls-lost')).toMatchObject({ status: 'completed', error: null });
      expect(await states(db, [middle1!, leaf1!, middle2!, leaf2!])).toEqual([
        { status: 'completed', error: null },
        { status: 'completed', error: null },
        { status: 'completed', error: null },
        { status: 'completed', error: null },
      ]);
    } finally {
      await root.end();
      await current.crash();
      await db.end();
    }
  }, 180_000);

  it('a resend that re-arms a run killed before its workflow was saved, while the pass a restart makes holds it, is never ended by that pass', async () => {
    const { databaseUrl, db, service } = await stack({});
    let current = service;
    const systemDatabase = `${new URL(databaseUrl).pathname.slice(1)}_dbos`;
    const saves = new Client({ connectionString: withDatabase(databaseUrl, systemDatabase) });
    const first = new Client({ connectionString: databaseUrl });
    await saves.connect();
    await first.connect();
    const holdSaves = async () => {
      await saves.query('BEGIN');
      await saves.query('LOCK TABLE dbos.workflow_status IN SHARE ROW EXCLUSIVE MODE');
    };
    const saveHeld = () =>
      until(
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO "dbos".workflow_status%'`,
              [systemDatabase],
            )
          ).rowCount === 1,
        'a workflow save held',
      );
    try {
      fixture.hold('/adry');
      fixture.hold('/zzdry');
      void dryRun(current, 'a-dry', 'adry').catch(() => undefined);
      void dryRun(current, 'zz-dry', 'zzdry').catch(() => undefined);
      await fixture.untilHit('/adry');
      await fixture.untilHit('/zzdry');
      await holdSaves();
      void start(current, 'killed', ['killed1']).catch(() => undefined);
      await saveHeld();
      await current.crash();
      await saves.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      await saves.query('ROLLBACK');
      fixture.release('/adry');
      fixture.release('/zzdry');
      // The pass takes runs in id order: held at the first, it has already read the killed run as left going.
      await first.query('BEGIN');
      await first.query(LOCK_RUN, [`${MOCK_USER_ID}:a-dry`]);
      current = await bootService({ service: THIS_SERVICE, databaseUrl });
      await until(async () => (await lockWaits(db)) === 1, 'the pass held at the first run');

      await holdSaves();
      const resent = start(current, 'killed', ['killed1']);
      await saveHeld();
      await first.query('COMMIT');

      expect(await ended(db, 'zz-dry')).toMatchObject({ status: 'error', error: INTERRUPTED });
      expect(await states(db, [`${MOCK_USER_ID}:killed`])).toEqual([{ status: 'running', error: null }]);
      await saves.query('ROLLBACK');
      expect((await resent).status).toBe(201);
      expect(await ended(db, 'killed')).toMatchObject({ status: 'completed', error: null });
      expect(fixture.count('/killed1')).toBe(1);
    } finally {
      await saves.query('ROLLBACK').catch(() => undefined);
      await saves.end();
      await first.end();
      await current.crash();
      await db.end();
    }
  }, 180_000);
});
