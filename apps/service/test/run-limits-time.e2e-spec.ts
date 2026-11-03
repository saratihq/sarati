import { Client } from 'pg';
import request from 'supertest';

import { DbosRuntime } from '../src/dbos/dbos-runtime';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { ir, irNode } from './support/golden-docs';
import {
  bootLimitsApp,
  callStep,
  chain,
  edgeOn,
  HitFixture,
  type LimitsApp,
  MOCK_USER_ID,
  runRow,
  until,
} from './support/limits-fixture';

const MAX_ACTIVE_SECONDS = 3;
const STOPPED_STEP = 'Stopped before it finished — the run reached a limit.';
const TIME_LIMIT = `Run limit reached: this run was in flight for more than ${MAX_ACTIVE_SECONDS} s since it started or last resumed from a wait, the longest one run may go in this workspace. An operator can raise RUN_MAX_ACTIVE_SECONDS.`;
const CRASHED =
  'Run did not complete within the maximum duration — the worker likely crashed, was killed, or was interrupted by a deploy.';

/** A run's time in flight, checked at its every step and by the reaper, which stops a live run past it (in process, DBOS on, mock auth). */
describe('run limits: time in flight (e2e, DBOS on)', () => {
  const fixture = new HitFixture();
  let limits: LimitsApp;
  let dbos: Client;
  const http = () => request(limits.app.getHttpServer());
  const reap = () => limits.app.get(RunReaperService).reapStale();

  const start = (runId: string, nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) =>
    http()
      .post('/api/runs/from-ir')
      .send({ run_id: runId, workflow_ir: ir(nodes, edges), ...extra })
      .then((res) => res);

  // Waits on the database's own clock, so the run is past its time however long the wait takes.
  const untilInFlightFor = (runId: string, seconds: number) =>
    until(async () => {
      const { rows } = await limits.db.query<{ over: boolean }>(
        `SELECT GREATEST(r.started_at, r.active_since) < now() - make_interval(secs => $2::double precision) AS over
           FROM runtime_runs r WHERE r.run_id = $1`,
        [runId, seconds],
      );
      return rows[0]?.over === true;
    }, `${runId} in flight for ${seconds}s`);

  // Its start alone, so a test can count from it whatever moved the run's clock since.
  const untilStartedAgo = (runId: string, seconds: number) =>
    until(async () => {
      const { rows } = await limits.db.query<{ over: boolean }>(
        `SELECT started_at < now() - make_interval(secs => $2::double precision) AS over FROM runtime_runs WHERE run_id = $1`,
        [runId, seconds],
      );
      return rows[0]?.over === true;
    }, `${runId} started ${seconds}s ago`);

  const untilParked = (runId: string, where = `r.run_id = $1`) =>
    until(
      async () =>
        (
          await limits.db.query(
            `SELECT 1 FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
              WHERE ${where} AND s.waiting_topic IS NOT NULL AND s.finished_at IS NULL`,
            [runId],
          )
        ).rowCount === 1,
      `a wait of ${runId} parked`,
    );

  const stepError = async (
    runId: string,
    nodeId: string,
  ): Promise<{ status: string; error: string | null }> => {
    const { rows } = await limits.db.query<{ status: string; error: string | null }>(
      `SELECT s.status, s.error FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id WHERE r.run_id = $1 AND s.node_id = $2`,
      [runId, nodeId],
    );
    return rows[0]!;
  };

  const workflowStatus = async (runId: string): Promise<string | undefined> =>
    (
      await dbos.query<{ status: string }>(
        `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
        [`${MOCK_USER_ID}:${runId}`],
      )
    ).rows[0]?.status;

  beforeAll(async () => {
    await fixture.listen();
    limits = await bootLimitsApp({
      RUN_MAX_ACTIVE_SECONDS: String(MAX_ACTIVE_SECONDS),
      RUN_MAX_DURATION_SECONDS: '1',
      RUN_MAX_STEPS: '0',
    });
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `${url.pathname}_dbos`;
    dbos = new Client({ connectionString: url.toString() });
    await dbos.connect();
  }, 60_000);

  afterAll(async () => {
    await dbos.end();
    await limits.close();
    await fixture.close();
  }, 60_000);

  beforeEach(() => fixture.reset());

  it('a run in flight past its time limit is refused at its next step, and its caller is answered 422', async () => {
    fixture.hold('/slow');
    const answered = start(
      'time-past',
      [callStep(fixture.base, 'slow'), callStep(fixture.base, 'next')],
      chain(['slow', 'next']),
    );
    await fixture.untilHit('/slow');
    await untilInFlightFor('time-past', MAX_ACTIVE_SECONDS + 0.2);
    fixture.release('/slow');
    const res = await answered;

    expect(fixture.count('/next')).toBe(0);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.active_seconds',
      max: MAX_ACTIVE_SECONDS,
      detail: TIME_LIMIT,
    });
    expect(await runRow(limits.db, 'time-past')).toMatchObject({ status: 'error', error: TIME_LIMIT });
    expect(await stepError('time-past', 'next')).toEqual({ status: 'error', error: TIME_LIMIT });
  }, 60_000);

  it('time parked on an approval does not count: a run waiting past its time limit, then approved, completes', async () => {
    const answered = start(
      'time-parked',
      [
        callStep(fixture.base, 'before'),
        irNode('approval', 'orchestr:wait_for_event', { topic: 'approval', timeout_ms: 600_000 }),
        callStep(fixture.base, 'after'),
      ],
      chain(['before', 'approval', 'after']),
    );
    await until(
      async () =>
        (
          await limits.db.query(
            `SELECT 1 FROM runtime_runs WHERE run_id = 'time-parked' AND status = 'waiting'`,
          )
        ).rowCount === 1,
      'the run parked',
    );
    await untilInFlightFor('time-parked', MAX_ACTIVE_SECONDS + 0.5);
    await http().post('/api/runs/time-parked/events').send({ topic: 'approval', payload: {} }).expect(200);
    const res = await answered;

    expect(res.status).toBe(201);
    expect(fixture.count('/after')).toBe(1);
    expect(await runRow(limits.db, 'time-parked')).toMatchObject({ status: 'completed', error: null });
  }, 60_000);

  it('a lane in flight beside a parked one keeps the run in flight: the reaper stops it past its time limit, and nothing after the busy step runs', async () => {
    fixture.hold('/besidebusy');
    const answered = start(
      'beside-parked',
      [
        callStep(fixture.base, 'besidebusy'),
        callStep(fixture.base, 'besidenext'),
        irNode('gate', 'orchestr:wait_for_event', { topic: 'gate', timeout_ms: 600_000 }),
      ],
      chain(['besidebusy', 'besidenext']),
    );
    await fixture.untilHit('/besidebusy');
    await untilParked('beside-parked');
    expect((await runRow(limits.db, 'beside-parked')).status).toBe('waiting');
    await untilInFlightFor('beside-parked', MAX_ACTIVE_SECONDS + 0.2);

    expect((await reap()).stoppedRuns).toBe(1);
    expect(await runRow(limits.db, 'beside-parked')).toMatchObject({ status: 'error', error: TIME_LIMIT });
    fixture.release('/besidebusy');
    const res = await answered;

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'run_limit_reached', limit: 'run.active_seconds' });
    expect(fixture.count('/besidenext')).toBe(0);
  }, 60_000);

  it('a wait ending beside a lane that stayed in flight never starts the run’s time again: the busy lane is refused at its next step', async () => {
    fixture.hold('/stayedbusy');
    const answered = start(
      'sibling-resumed',
      [
        callStep(fixture.base, 'stayedbusy'),
        callStep(fixture.base, 'stayednext'),
        irNode('nudge', 'orchestr:wait_for_event', { topic: 'nudge', timeout_ms: 600_000 }),
      ],
      chain(['stayedbusy', 'stayednext']),
    );
    await fixture.untilHit('/stayedbusy');
    await untilParked('sibling-resumed');
    await untilStartedAgo('sibling-resumed', MAX_ACTIVE_SECONDS - 1);
    await http().post('/api/runs/sibling-resumed/events').send({ topic: 'nudge', payload: {} }).expect(200);
    await until(
      async () =>
        (
          await limits.db.query(
            `SELECT 1 FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
              WHERE r.run_id = 'sibling-resumed' AND s.node_id = 'nudge' AND s.finished_at IS NOT NULL`,
          )
        ).rowCount === 1,
      'the nudge taken',
    );
    await untilStartedAgo('sibling-resumed', MAX_ACTIVE_SECONDS + 0.2);
    fixture.release('/stayedbusy');
    const res = await answered;

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.active_seconds',
      detail: TIME_LIMIT,
    });
    expect(fixture.count('/stayednext')).toBe(0);
    const clock = await limits.db.query<{ active_since: Date | null }>(
      `SELECT active_since FROM runtime_runs WHERE run_id = 'sibling-resumed'`,
    );
    expect(clock.rows).toEqual([{ active_since: null }]);
  }, 60_000);

  it('a Wait inside a called workflow is time parked: the reaper passes over the run while it waits, and the steps after it run', async () => {
    const child = await http()
      .post('/api/deploy')
      .send({
        workflow_json: ir(
          [
            irNode('trigger', 'orchestr:tool_trigger', {
              tool_name: 'waits_a_minute',
              description: 'waits past a minute',
              inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
            }),
            irNode('pause', 'orchestr:wait_for_duration', { amount: 1.02, unit: 'minutes' }),
            callStep(fixture.base, 'afterpause'),
          ],
          [edgeOn('trigger', 'pause'), ...chain(['pause', 'afterpause'])],
        ),
      })
      .expect(201);
    const answered = start(
      'calls-a-wait',
      [
        irNode('call', 'orchestr:call_workflow', { workflow_id: child.body.workflow_id }),
        callStep(fixture.base, 'aftercall'),
      ],
      chain(['call', 'aftercall']),
    );
    await untilParked('calls-a-wait', `r.parent_run_id = (SELECT id FROM runtime_runs WHERE run_id = $1)`);
    await untilInFlightFor('calls-a-wait', MAX_ACTIVE_SECONDS + 0.2);

    expect((await reap()).stoppedRuns).toBe(0);
    const res = await answered;

    expect(res.status).toBe(201);
    expect({ pause: fixture.count('/afterpause'), call: fixture.count('/aftercall') }).toEqual({
      pause: 1,
      call: 1,
    });
    expect(await runRow(limits.db, 'calls-a-wait')).toMatchObject({ status: 'completed', error: null });
  }, 120_000);

  it('the reaper stops a live durable run whose step stays in flight past its time limit: the row reads the limit while the step is held, DBOS reads CANCELLED, the held step finishes, nothing after it runs, and its caller is answered 422', async () => {
    fixture.hold('/held');
    const answered = start(
      'reaped-live',
      [callStep(fixture.base, 'held'), callStep(fixture.base, 'after')],
      chain(['held', 'after']),
    );
    await fixture.untilHit('/held');
    await untilInFlightFor('reaped-live', MAX_ACTIVE_SECONDS + 0.2);

    expect((await reap()).stoppedRuns).toBe(1);
    expect(await runRow(limits.db, 'reaped-live')).toMatchObject({ status: 'error', error: TIME_LIMIT });
    expect(await workflowStatus('reaped-live')).toBe('CANCELLED');
    fixture.release('/held');
    const res = await answered;

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.active_seconds',
      detail: TIME_LIMIT,
    });
    expect(fixture.count('/after')).toBe(0);
    expect(await stepError('reaped-live', 'held')).toEqual({ status: 'completed', error: null });
    expect(await stepError('reaped-live', 'after')).toEqual({ status: 'error', error: STOPPED_STEP });
    expect(await runRow(limits.db, 'reaped-live')).toMatchObject({ status: 'error', error: TIME_LIMIT });
  }, 60_000);

  it('a stop decided while a lane was busy stands when that lane’s last step finishes as DBOS is told: the run reads the limit, never a cancel', async () => {
    fixture.hold('/racebusy');
    const answered = start(
      'stop-races-finish',
      [
        callStep(fixture.base, 'racebusy'),
        irNode('racegate', 'orchestr:wait_for_event', { topic: 'racegate', timeout_ms: 600_000 }),
      ],
      [],
    );
    await fixture.untilHit('/racebusy');
    await untilParked('stop-races-finish');
    await untilInFlightFor('stop-races-finish', MAX_ACTIVE_SECONDS + 0.2);
    const runtime = limits.app.get(DbosRuntime);
    const tell = runtime.cancelWorkflow.bind(runtime);
    // The busy lane's last step finishes once the stop is decided, before DBOS hears of it.
    const told = jest.spyOn(runtime, 'cancelWorkflow').mockImplementation(async (id) => {
      fixture.release('/racebusy');
      await until(
        async () => (await stepError('stop-races-finish', 'racebusy')).status === 'completed',
        'the busy step finished',
      );
      return tell(id);
    });
    try {
      expect((await reap()).stoppedRuns).toBe(1);
    } finally {
      told.mockRestore();
    }
    const res = await answered;

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.active_seconds',
      detail: TIME_LIMIT,
    });
    expect(await runRow(limits.db, 'stop-races-finish')).toMatchObject({
      status: 'error',
      error: TIME_LIMIT,
    });
    expect(await stepError('stop-races-finish', 'racegate')).toMatchObject({ error: STOPPED_STEP });
  }, 60_000);

  it("a stopped run's last step finishing never rewrites it as completed", async () => {
    fixture.hold('/last');
    const answered = start('reaped-last', [callStep(fixture.base, 'last')], []);
    await fixture.untilHit('/last');
    await untilInFlightFor('reaped-last', MAX_ACTIVE_SECONDS + 0.2);

    expect((await reap()).stoppedRuns).toBe(1);
    fixture.release('/last');
    const res = await answered;

    expect(res.status).toBe(422);
    expect(await stepError('reaped-last', 'last')).toEqual({ status: 'completed', error: null });
    expect(await runRow(limits.db, 'reaped-last')).toMatchObject({ status: 'error', error: TIME_LIMIT });
  }, 60_000);

  it('a stop reaches a sub-workflow a durable run is calling: it reads Cancelled and its next step never runs', async () => {
    const child = await http()
      .post('/api/deploy')
      .send({
        workflow_json: ir(
          [
            irNode('trigger', 'orchestr:tool_trigger', {
              tool_name: 'held_child',
              description: 'holds a call',
              inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
            }),
            callStep(fixture.base, 'inchild'),
            callStep(fixture.base, 'childnext'),
          ],
          [edgeOn('trigger', 'inchild'), ...chain(['inchild', 'childnext'])],
        ),
      })
      .expect(201);
    fixture.hold('/inchild');
    const answered = start(
      'reaped-caller',
      [
        irNode('call', 'orchestr:call_workflow', { workflow_id: child.body.workflow_id }),
        callStep(fixture.base, 'callerafter'),
      ],
      chain(['call', 'callerafter']),
    );
    await fixture.untilHit('/inchild');
    await untilInFlightFor('reaped-caller', MAX_ACTIVE_SECONDS + 0.2);

    expect((await reap()).stoppedRuns).toBe(1);
    fixture.release('/inchild');
    const res = await answered;

    expect(res.status).toBe(422);
    expect({ next: fixture.count('/childnext'), after: fixture.count('/callerafter') }).toEqual({
      next: 0,
      after: 0,
    });
    const called = await limits.db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM runtime_runs WHERE parent_run_id = (SELECT id FROM runtime_runs WHERE run_id = 'reaped-caller')`,
    );
    expect(called.rows).toEqual([{ status: 'cancelled', error: null }]);
    expect(await runRow(limits.db, 'reaped-caller')).toMatchObject({ status: 'error', error: TIME_LIMIT });
  }, 60_000);

  it('the reaper stops an in-process run, a dry run, past its time limit before its next step', async () => {
    fixture.hold('/dryheld');
    const answered = start(
      'reaped-dry',
      [callStep(fixture.base, 'dryheld'), callStep(fixture.base, 'drynext')],
      chain(['dryheld', 'drynext']),
      { dry_run: true },
    );
    await fixture.untilHit('/dryheld');
    await untilInFlightFor('reaped-dry', MAX_ACTIVE_SECONDS + 0.2);

    expect((await reap()).stoppedRuns).toBe(1);
    fixture.release('/dryheld');
    const res = await answered;

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'run_limit_reached', limit: 'run.active_seconds' });
    expect(fixture.count('/drynext')).toBe(0);
    expect(await stepError('reaped-dry', 'drynext')).toEqual({ status: 'error', error: STOPPED_STEP });
    expect(await runRow(limits.db, 'reaped-dry')).toMatchObject({ status: 'error', error: TIME_LIMIT });
  }, 60_000);

  it('the crash pass passes over a live run past RUN_MAX_DURATION_SECONDS within its own time limit, and still relabels a run nothing here holds', async () => {
    fixture.hold('/young');
    const answered = start('live-young', [callStep(fixture.base, 'young')], []);
    await fixture.untilHit('/young');
    await untilInFlightFor('live-young', 1.2);
    await limits.db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, limits)
       VALUES ($1, 'orphan', $2, 'p', 'running', now() - interval '2 hours', '{"run.active_seconds": 100000}')`,
      [`${MOCK_USER_ID}:orphan`, MOCK_USER_ID],
    );

    const swept = await reap();

    expect(swept).toMatchObject({ stoppedRuns: 0, crashedRuns: 1 });
    expect(await runRow(limits.db, 'live-young')).toMatchObject({ status: 'running', error: null });
    expect(await runRow(limits.db, 'orphan')).toMatchObject({ status: 'error', error: CRASHED });
    fixture.release('/young');
    expect((await answered).status).toBe(201);
  }, 60_000);

  it('a run is stopped by the time it was admitted under, and one recorded without limits never is', async () => {
    fixture.hold('/admitted');
    const answered = start('admitted-longer', [callStep(fixture.base, 'admitted')], []);
    await fixture.untilHit('/admitted');
    // As if it had been admitted where the workspace may run longer.
    await limits.db.query(
      `UPDATE runtime_runs SET limits = '{"run.steps": null, "run.loop_rounds": null, "run.active_seconds": 100000}' WHERE run_id = 'admitted-longer'`,
    );
    await limits.db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at)
       VALUES ($1, 'unlimited', $2, 'p', 'running', now() - interval '2 hours')`,
      [`${MOCK_USER_ID}:unlimited`, MOCK_USER_ID],
    );
    await untilInFlightFor('admitted-longer', MAX_ACTIVE_SECONDS + 0.2);

    const swept = await reap();

    expect(swept.stoppedRuns).toBe(0);
    expect(await runRow(limits.db, 'admitted-longer')).toMatchObject({ status: 'running', error: null });
    expect(await runRow(limits.db, 'unlimited')).toMatchObject({ status: 'error', error: CRASHED });
    fixture.release('/admitted');
    expect((await answered).status).toBe(201);
  }, 60_000);
});

/** RUN_MAX_DURATION_SECONDS=0 turns off the passes for runs nothing here holds, never the time stop (in process, DBOS and pg-boss on). */
describe('run limits: time in flight with the crash passes off (e2e, DBOS and pg-boss on)', () => {
  const fixture = new HitFixture();
  let limits: LimitsApp;
  const http = () => request(limits.app.getHttpServer());

  beforeAll(async () => {
    await fixture.listen();
    limits = await bootLimitsApp({
      RUN_MAX_ACTIVE_SECONDS: String(MAX_ACTIVE_SECONDS),
      RUN_MAX_DURATION_SECONDS: '0',
      RUN_MAX_STEPS: '0',
      PGBOSS_ENABLED: 'true',
    });
  }, 60_000);

  afterAll(async () => {
    await limits.close();
    await fixture.close();
  }, 60_000);

  it('the reaper is still scheduled, and stops a live run past its time, while a run nothing here holds is left to the passes turned off', async () => {
    const scheduled = await limits.db.query(`SELECT name, cron FROM pgboss.schedule WHERE name = 'run-reap'`);
    expect(scheduled.rows).toEqual([{ name: 'run-reap', cron: '*/5 * * * *' }]);
    fixture.hold('/offheld');
    const answered = http()
      .post('/api/runs/from-ir')
      .send({
        run_id: 'reaper-off',
        workflow_ir: ir(
          [callStep(fixture.base, 'offheld'), callStep(fixture.base, 'offafter')],
          chain(['offheld', 'offafter']),
        ),
      })
      .then((res) => res);
    await fixture.untilHit('/offheld');
    await limits.db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at)
       VALUES ($1, 'nothing-holds', $2, 'p', 'running', now() - interval '2 hours')`,
      [`${MOCK_USER_ID}:nothing-holds`, MOCK_USER_ID],
    );
    await until(async () => {
      const { rows } = await limits.db.query<{ over: boolean }>(
        `SELECT started_at < now() - make_interval(secs => $1::double precision) AS over FROM runtime_runs WHERE run_id = 'reaper-off'`,
        [MAX_ACTIVE_SECONDS + 0.2],
      );
      return rows[0]?.over === true;
    }, 'reaper-off past its time');

    // A pass the cron may run meanwhile stops it the same way, so what counts is the row.
    await limits.app.get(RunReaperService).reapStale();

    expect(await runRow(limits.db, 'reaper-off')).toMatchObject({ status: 'error', error: TIME_LIMIT });
    expect(await runRow(limits.db, 'nothing-holds')).toMatchObject({ status: 'running', error: null });
    fixture.release('/offheld');
    const res = await answered;
    expect(res.status).toBe(422);
    expect(fixture.count('/offafter')).toBe(0);
  }, 60_000);
});
