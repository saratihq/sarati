import { randomUUID } from 'node:crypto';
import { Agent, createServer, get, request as send, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import type PgBoss from 'pg-boss';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ShutdownDeadline, ShuttingDown } from '../src/common/shutdown-deadline';
import { SchemaGuard } from '../src/database/schema-guard';
import { DbosLifecycle } from '../src/dbos/dbos.lifecycle';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import type { WorkflowIR } from '../src/ir/models';
import { JobRegistry, PG_BOSS } from '../src/jobs/jobs.module';
import { ReviewTestService } from '../src/reviews/review-test.service';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { RunsService } from '../src/runs/runs.service';
import { SubWorkflowRunnerService } from '../src/sub-workflow/sub-workflow-runner.service';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { bootService, THIS_SERVICE } from './support/service-process';
import { deferred, lockProbes, reached } from './support/lock-probes';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const HELD_QUEUE = 'e2e-held';
const LATE_QUEUE = 'e2e-late';
const SHORT_QUEUE = 'e2e-short';
const FETCHED_QUEUE = 'e2e-fetched';
const SHUT_OUT =
  /Driver not Connected|Connection terminated|Cannot use a pool|DBOS\.launch|could not be started/;
const JOBS_WAITED_ON = /^log: Shutting down: waiting up to \d+ ms for \d+ job\(s\) in flight: /;

function doc(
  name: string,
  trigger: { node_type: string; parameters?: Record<string, unknown> },
  url: string,
) {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Trigger',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
        ...trigger,
      },
      {
        id: 'step',
        name: 'Step',
        node_type: 'http.send_request',
        type_version: 1,
        parameters: { method: 'GET', url },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-step',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'step',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

async function eventually<T>(
  what: string,
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never saw ${what}`);
}

/** Every stop drains pg-boss's jobs before DBOS and the database pools stop, and admits no run once its runs have begun to stop. */
describe('a stop drains its jobs before DBOS stops (e2e, isolated DB, pg-boss and DBOS on)', () => {
  let fixture: Server;
  let base = '';
  const gate: ServerResponse[] = [];
  let gateOpen = false;
  let databaseUrl = '';
  let db: Client;
  let system: Client | undefined;
  let app: INestApplication | undefined;
  let lines: string[] = [];
  const lockers: Array<() => Promise<void>> = [];

  const openGate = (): void => {
    gateOpen = true;
    for (const res of gate.splice(0)) res.end('{"ok":true}');
  };

  // The service built and configured, not yet initialised.
  const assemble = async ({ dbos = true } = {}): Promise<INestApplication> => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGBOSS_ENABLED = 'true';
    process.env.DBOS_ENABLED = String(dbos);
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.MOCK_AUTH = 'true';
    process.env.THROTTLE_LIMIT = '10000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const assembled = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(assembled);
    return assembled;
  };

  const boot = async ({ dbos = true } = {}): Promise<INestApplication> => {
    const booted = await assemble({ dbos });
    await booted.init();
    await listenOnLoopback(booted);
    await booted.get(RunReaperService).booted();
    if (dbos && !system) {
      const url = new URL(databaseUrl);
      url.pathname = `${url.pathname}_dbos`;
      system = new Client({ connectionString: url.toString() });
      await system.connect();
    }
    return booted;
  };

  // Runs `onStop` as DBOS starts to stop, then stops it.
  const whenDbosStops = (onStop: () => void): void => {
    const stop = DbosLifecycle.prototype.onApplicationShutdown;
    jest.spyOn(DbosLifecycle.prototype, 'onApplicationShutdown').mockImplementation(async function (
      this: DbosLifecycle,
    ) {
      onStop();
      await stop.call(this);
    });
  };

  /** A schedule activation due now, whose run calls `path` on the fixture; resolves its workflow, activation and cursor. */
  const dueSchedule = async (name: string, path: string) => {
    const http = request(app!.getHttpServer());
    const trigger = { node_type: 'orchestr:schedule', parameters: { interval_minutes: 60 } };
    const wf = (await http.post('/api/deploy').send({ workflow_json: doc(name, trigger, `${base}${path}`) }))
      .body.workflow_id as string;
    await app!.get(TriggerReconcilerService).reconcile(wf);
    const activation = (
      await eventually(
        `${name}'s activation`,
        () =>
          db.query<{ id: string }>(`SELECT id FROM runtime_trigger_activations WHERE workflow_id = $1`, [wf]),
        (r) => r.rowCount === 1,
      )
    ).rows[0]!.id;
    await eventually(
      'no reconcile job left to run',
      () =>
        db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pgboss.job
            WHERE name LIKE 'trigger-reconcile%' AND state IN ('created', 'active', 'retry')`,
        ),
      (r) => r.rows[0]!.n === 0,
    );
    const lastFire = new Date(Date.now() - 61 * 60_000).toISOString();
    await db.query(
      `UPDATE runtime_activation_store SET value = to_json($2::text) WHERE activation_id = $1 AND key = 'schedule.lastFire'`,
      [activation, lastFire],
    );
    return { wf, activation, lastFire };
  };

  const activationOf = async (activation: string) =>
    (
      await db.query<{ last_error: string | null; cursor: string }>(
        `SELECT a.last_error, s.value AS cursor FROM runtime_trigger_activations a
           JOIN runtime_activation_store s ON s.activation_id = a.id AND s.key = 'schedule.lastFire'
          WHERE a.id = $1`,
        [activation],
      )
    ).rows[0]!;

  const runsOf = async (wf: string) =>
    (
      await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM runtime_runs WHERE workflow_id = $1`,
        [wf],
      )
    ).rows;

  const workflowStatus = async (runId: string) =>
    (
      await system!.query<{ status: string }>(
        `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
        [runId],
      )
    ).rows;

  // A hold on `runtime_runs` that an admission's insert waits on; idempotent release.
  const holdRunInserts = async () => {
    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE runtime_runs IN SHARE ROW EXCLUSIVE MODE');
    let released: Promise<void> | undefined;
    const waiting = () =>
      eventually(
        'an admission wait on its run insert',
        () =>
          db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO runtime_runs%'`,
          ),
        (r) => r.rows[0]!.n === 1,
      );
    const release = (): Promise<void> => (released ??= locker.query('COMMIT').then(async () => locker.end()));
    lockers.push(release);
    return { waiting, release };
  };

  const stopWaitedOnJobs = (): boolean => lines.some((line) => JOBS_WAITED_ON.test(line));

  const jobOf = async (id: string) =>
    (
      await db.query<{ state: string; started_on: Date | null; output: unknown }>(
        `SELECT state, started_on, output FROM pgboss.job WHERE id = $1`,
        [id],
      )
    ).rows[0];

  // A job left waiting for the next boot: its queue's worker stops first, as a stop's does.
  const leaveWaiting = async (queue: string): Promise<string> => {
    const boss = app!.get<PgBoss>(PG_BOSS);
    await boss.offWork(queue);
    const left = (await boss.send(queue, {}))!;
    await app!.close();
    app = undefined;
    expect(await jobOf(left)).toMatchObject({ state: 'created', started_on: null });
    return left;
  };

  // A deferred the suite resolves after each test, so one that fails leaves nothing waiting on it.
  const released = () => {
    const held = deferred();
    lockers.push(() => Promise.resolve(held.resolve()));
    return held;
  };

  // A job of HELD_QUEUE running until `release`, which keeps the stop waiting on its jobs.
  const holdJob = async () => {
    const started = deferred();
    const release = released();
    await app!.get(JobRegistry).register(async (queues) => {
      await queues.createQueue(HELD_QUEUE);
      await queues.work(HELD_QUEUE, async () => {
        started.resolve();
        await release.promise;
      });
    });
    const id = (await app!.get<PgBoss>(PG_BOSS).send(HELD_QUEUE, {}))!;
    await reached(started.promise, 'the held job', 10_000);
    return { id, release: release.resolve };
  };

  // Holds the next fetch of `queue` that `ready` allows until `release`, then runs `fetched` once that fetch has taken its job.
  const holdFetch = (
    queue: string,
    {
      ready = () => Promise.resolve(true),
      fetched = () => Promise.resolve(),
    }: { ready?: () => Promise<boolean>; fetched?: () => Promise<unknown> } = {},
  ) => {
    const pgboss = app!.get<PgBoss>(PG_BOSS).getDb();
    const execute = pgboss.executeSql.bind(pgboss);
    const fetching = deferred();
    const release = released();
    let caught = false;
    jest.spyOn(pgboss, 'executeSql').mockImplementation(async (text, values) => {
      if (caught || !text.includes('SKIP LOCKED') || values[0] !== queue || !(await ready())) {
        return execute(text, values);
      }
      caught = true;
      fetching.resolve();
      await release.promise;
      const taken = await execute(text, values);
      await fetched();
      return taken;
    });
    return { fetching: fetching.promise, release: release.resolve };
  };

  const jobsOf = async (queue: string) =>
    (
      await db.query<{
        id: string;
        state: string;
        data: unknown;
        retry_limit: number;
        retry_count: number;
        singleton_key: string | null;
      }>(
        `SELECT id, state, data, retry_limit, retry_count, singleton_key FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
        [queue],
      )
    ).rows;

  // Records each worker pg-boss attaches in `order`.
  const watchWorkers = (assembled: INestApplication, order: string[]): void => {
    const boss = assembled.get<PgBoss>(PG_BOSS);
    const work = boss.work.bind(boss) as (...args: unknown[]) => Promise<string>;
    jest.spyOn(boss, 'work').mockImplementation(((...args: unknown[]) => {
      order.push(`worker ${String(args[0])}`);
      return work(...args);
    }) as typeof boss.work);
  };

  // An open GET whose response is never read to its end by the test; destroyed after each test.
  const openStream = (url: string) =>
    new Promise<{ status: number; ended: Promise<boolean> }>((resolve, reject) => {
      const req = get(url, (res) => {
        // True once the server ended the response, false if the connection was cut first.
        const ended = new Promise<boolean>((done) => res.once('close', () => done(res.complete)));
        res.resume();
        resolve({ status: res.statusCode ?? 0, ended });
      });
      req.on('error', reject);
      lockers.push(() => Promise.resolve(void req.destroy()));
    });

  beforeAll(async () => {
    fixture = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/gate' && !gateOpen) gate.push(res);
      else res.end('{"ok":true}');
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    gateOpen = false;
    lines = [];
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    for (const level of ['log', 'warn', 'error'] as const) {
      const write = Logger.prototype[level];
      jest.spyOn(Logger.prototype, level).mockImplementation(function (
        this: Logger,
        message: unknown,
        ...rest
      ) {
        lines.push(`${level}: ${String(message)}`);
        return write.call(this, message, ...rest);
      });
    }
  }, 30_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const release of lockers.splice(0)) await release();
    openGate();
    await app?.close();
    app = undefined;
    await system?.end();
    system = undefined;
    await db.end();
  }, 60_000);

  afterAll(async () => {
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
    process.env.PGBOSS_ENABLED = 'false';
  });

  it('closing the service waits for a job in flight before DBOS stops, takes no job sent meanwhile, and the job writes with its database there', async () => {
    await db.query(`CREATE TABLE e2e_job_writes (job_id uuid PRIMARY KEY)`);
    app = await boot();
    const order: string[] = [];
    const started = deferred();
    const release = deferred();
    const dataSource = app.get(DataSource);
    const dbos = app.get(DbosRuntime);
    const boss = app.get<PgBoss>(PG_BOSS);
    const attached = jest.spyOn(boss, 'work');
    await app.get(JobRegistry).register(async (queues) => {
      await queues.createQueue(HELD_QUEUE);
      await queues.work(HELD_QUEUE, async ([job]) => {
        started.resolve();
        await release.promise;
        order.push(`DBOS answered: holds none = ${String(!(await dbos.holdsWorkflow(randomUUID())))}`);
        await dataSource.query(`INSERT INTO e2e_job_writes (job_id) VALUES ($1)`, [job!.id]);
        order.push('job wrote');
      });
    });
    const worker = await (attached.mock.results[0]!.value as Promise<string>);
    const first = await boss.send(HELD_QUEUE, {});
    await reached(started.promise, 'the held job', 10_000);
    whenDbosStops(() => {
      order.push('DBOS stopping');
      release.resolve();
    });

    const closing = app.close();
    app = undefined;
    await eventually(
      'the stop wait on its jobs, or DBOS stop',
      () => stopWaitedOnJobs() || order.length > 0,
      Boolean,
    );
    const sentDuringStop = await boss.send(HELD_QUEUE, {});
    // Woken, a worker still fetching takes that job as soon as the held one ends.
    boss.notifyWorker(worker);
    release.resolve();
    await closing;

    expect(order).toEqual(['DBOS answered: holds none = true', 'job wrote', 'DBOS stopping']);
    expect(lines).toContainEqual(
      expect.stringMatching(new RegExp(`${JOBS_WAITED_ON.source}.*${HELD_QUEUE}`)),
    );
    const jobs = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
      [HELD_QUEUE],
    );
    expect(jobs.rows).toEqual([
      { id: first, state: 'completed' },
      { id: sentDuringStop, state: 'created' },
    ]);
    expect((await db.query(`SELECT job_id FROM e2e_job_writes`)).rows).toEqual([{ job_id: first }]);
    expect(lines.filter((line) => SHUT_OUT.test(line) || line.includes('stopped waiting'))).toEqual([]);
  }, 60_000);

  it('a poll job held at its run’s admission when the service closes admits the run before DBOS stops, waits on it no longer, and the run completes with its cursor moved', async () => {
    app = await boot();
    const { wf, activation, lastFire } = await dueSchedule('polled at the stop', '/gate');
    const triggers = app.get(TriggersService);
    let polling = 0;
    const cycle = triggers.runActivationPollCycle.bind(triggers);
    jest.spyOn(triggers, 'runActivationPollCycle').mockImplementation(async (signal) => {
      polling += 1;
      try {
        await cycle(signal);
      } finally {
        polling -= 1;
      }
    });
    const inserts = await holdRunInserts();
    await app.get<PgBoss>(PG_BOSS).send('trigger-poll', {});
    await inserts.waiting();
    let pollingAtDbosStop = -1;
    whenDbosStops(() => {
      pollingAtDbosStop = polling;
      void inserts.release();
      openGate();
    });

    const closing = app.close();
    app = undefined;
    await eventually(
      'the stop wait on its jobs, or DBOS stop',
      () => stopWaitedOnJobs() || pollingAtDbosStop >= 0,
      Boolean,
    );
    await inserts.release();
    await closing;

    expect(pollingAtDbosStop).toBe(0);
    const runs = await runsOf(wf);
    expect(runs).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(await workflowStatus(runs[0]!.id)).toEqual([{ status: 'SUCCESS' }]);
    const after = await activationOf(activation);
    expect(after.last_error).toBeNull();
    expect(after.cursor).not.toBe(lastFire);
    expect(lines.filter((line) => SHUT_OUT.test(line) || line.includes('stopped waiting'))).toEqual([]);
  }, 60_000);

  it.each([
    ['DBOS on', true],
    ['DBOS off', false],
  ])(
    'a poll job waiting on a run it fired when the service closes stops waiting at once, and the run completes (%s)',
    async (_rail, dbos) => {
      app = await boot({ dbos });
      const { wf, activation, lastFire } = await dueSchedule('waited on at the stop', '/gate');
      const triggers = app.get(TriggersService);
      let polling = 0;
      const cycle = triggers.runActivationPollCycle.bind(triggers);
      jest.spyOn(triggers, 'runActivationPollCycle').mockImplementation(async (signal) => {
        polling += 1;
        try {
          await cycle(signal);
        } finally {
          polling -= 1;
        }
      });
      await app.get<PgBoss>(PG_BOSS).send('trigger-poll', {});
      await eventually(
        'the fired run reach its gate',
        () => gate.length,
        (n) => n === 1,
      );
      expect(polling).toBe(1);
      const runs = app.get(RunsService);
      const stop = runs.onApplicationShutdown.bind(runs);
      let pollingAtRunsStop = -1;
      jest.spyOn(runs, 'onApplicationShutdown').mockImplementation(() => {
        pollingAtRunsStop = polling;
        openGate();
        return stop();
      });

      await app.close();
      app = undefined;

      expect(pollingAtRunsStop).toBe(0);
      const fired = await runsOf(wf);
      expect(fired).toEqual([expect.objectContaining({ status: 'completed' })]);
      if (dbos) expect(await workflowStatus(fired[0]!.id)).toEqual([{ status: 'SUCCESS' }]);
      const after = await activationOf(activation);
      expect(after.last_error).toBeNull();
      expect(after.cursor).not.toBe(lastFire);
      expect(
        lines.filter(
          (line) =>
            SHUT_OUT.test(line) || line.includes('stopped waiting') || line.includes('fired run failed'),
        ),
      ).toEqual([]);
    },
    60_000,
  );

  it('a poll job the stop catches before it admits anything admits nothing, polls no further activation, keeps every cursor and leaves no error; the next boot runs each tick once', async () => {
    app = await boot();
    const due = [
      await dueSchedule('caught before admitting a', '/ok'),
      await dueSchedule('caught before admitting b', '/ok'),
    ];
    const probes = lockProbes(
      () => app!,
      () => db,
    );
    const epochRead = probes.holdQuery(
      /^SELECT value FROM runtime_activation_store WHERE activation_id = \$1 AND key = \$2$/,
    );
    await app.get<PgBoss>(PG_BOSS).send('trigger-poll', {});
    await reached(epochRead.arrived, 'the poll’s epoch read');
    // Its one worker is held, so no other poll reaches the orphan reaper, which is due.
    const triggers = app.get(TriggersService);
    Object.assign(triggers, { lastComposioReapAt: 0 });
    const reapOrphans = jest.spyOn(triggers, 'reapOrphanedComposioSubscriptions');
    whenDbosStops(() => epochRead.release());

    const closing = app.close();
    app = undefined;
    await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
    epochRead.release();
    await closing;

    expect(
      lines.filter((line) => line.endsWith('not polled this cycle: the service is stopping')),
    ).toHaveLength(1);
    expect(reapOrphans).not.toHaveBeenCalled();
    for (const { wf, activation, lastFire } of due) {
      expect(await runsOf(wf)).toEqual([]);
      expect(await activationOf(activation)).toEqual({ last_error: null, cursor: lastFire });
    }
    expect(lines.filter((line) => SHUT_OUT.test(line))).toEqual([]);

    app = await boot();
    await app.get(TriggersService).runActivationPollCycle();
    for (const { wf, activation, lastFire } of due) {
      const runs = await eventually(
        `${wf}'s run`,
        () => runsOf(wf),
        (r) => r[0]?.status === 'completed',
      );
      expect(runs).toHaveLength(1);
      expect((await activationOf(activation)).cursor).not.toBe(lastFire);
    }
  }, 60_000);

  it('an admission still under way when the service’s runs stop is waited for before DBOS stops, and DBOS sees its run through', async () => {
    app = await boot();
    const runs = app.get(RunsService);
    const runsStopping = deferred();
    const stop = runs.onApplicationShutdown.bind(runs);
    jest.spyOn(runs, 'onApplicationShutdown').mockImplementation(() => {
      const stopping = stop();
      runsStopping.resolve();
      return stopping;
    });
    let admitted = false;
    const admit = runs.admit.bind(runs);
    jest.spyOn(runs, 'admit').mockImplementation((plan, opts) => {
      const admitting = admit(plan, opts);
      void admitting.finally(() => (admitted = true)).catch(() => undefined);
      return admitting;
    });
    const inserts = await holdRunInserts();
    const runId = randomUUID();
    const ir = doc(
      'admitted at the stop',
      { node_type: 'orchestr:trigger' },
      `${base}/ok`,
    ) as unknown as WorkflowIR;
    const starting = runs.startRun({ ir }, { externalUserId: MOCK_USER_ID, runId });
    await inserts.waiting();
    let admittedAtDbosStop: boolean | undefined;
    whenDbosStops(() => {
      admittedAtDbosStop = admitted;
    });

    const closing = app.close();
    app = undefined;
    await reached(runsStopping.promise, 'the runs’ stop');
    await inserts.release();
    await closing;

    expect(admittedAtDbosStop).toBe(true);
    await expect(starting).resolves.toEqual({ runId });
    const scoped = `${MOCK_USER_ID}:${runId}`;
    expect(lines).toContain('log: Shutting down: waiting for 1 run admission(s) under way');
    expect((await db.query(`SELECT status FROM runtime_runs WHERE id = $1`, [scoped])).rows).toEqual([
      { status: 'completed' },
    ]);
    expect(await workflowStatus(scoped)).toEqual([{ status: 'SUCCESS' }]);
  }, 60_000);

  it('an admission once the service’s runs have begun stopping is refused, and records nothing', async () => {
    app = await boot();
    const runs = app.get(RunsService);
    const runId = randomUUID();
    const ir = doc(
      'refused at the stop',
      { node_type: 'orchestr:trigger' },
      `${base}/ok`,
    ) as unknown as WorkflowIR;
    let refused: unknown;
    const stop = runs.onApplicationShutdown.bind(runs);
    jest.spyOn(runs, 'onApplicationShutdown').mockImplementation(async () => {
      const stopping = stop();
      refused = await runs
        .startRun({ ir }, { externalUserId: MOCK_USER_ID, runId })
        .catch((err: unknown) => err);
      return stopping;
    });

    await app.close();
    app = undefined;

    expect(refused).toBeInstanceOf(ShuttingDown);
    const scoped = `${MOCK_USER_ID}:${runId}`;
    expect((await db.query(`SELECT 1 FROM runtime_runs WHERE id = $1`, [scoped])).rows).toEqual([]);
    expect(await workflowStatus(scoped)).toEqual([]);
  }, 60_000);

  it('the wait for jobs in flight and the wait for in-process runs share the stop’s one 8 s deadline', async () => {
    app = await boot({ dbos: false });
    const http = request(app.getHttpServer());
    const wf = (
      await http
        .post('/api/deploy')
        .send({
          workflow_json: doc('in process at the stop', { node_type: 'orchestr:webhook' }, `${base}/gate`),
        })
        .expect(201)
    ).body.workflow_id as string;
    const fired = await http.post(`/api/hooks/${wf}/production`).send({}).expect(202);
    await eventually(
      'the run reach its gate',
      () => gate.length,
      (n) => n === 1,
    );
    const held = await holdJob();

    const closing = app.close();
    app = undefined;
    await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
    await new Promise((r) => setTimeout(r, 1_000));
    held.release();
    const runsWait = await eventually(
      'the stop wait on its in-process run',
      () => lines.find((line) => line.includes('in-process run(s) to end or park')),
      (line) => line !== undefined,
    );
    openGate();
    await closing;

    const waitedMs = Number(/waiting up to (\d+) ms/.exec(runsWait!)![1]);
    expect(waitedMs).toBeGreaterThan(0);
    expect(waitedMs).toBeLessThanOrEqual(7_000);
    expect(
      (
        await db.query(`SELECT status FROM runtime_runs WHERE id = $1`, [
          `${MOCK_USER_ID}:${fired.body.run_id}`,
        ])
      ).rows,
    ).toEqual([{ status: 'completed' }]);
  }, 60_000);

  it('a reconcile sweep the stop has aborted reconciles no further workflow, and says how far it got', async () => {
    app = await boot();
    const { wf } = await dueSchedule('swept', '/ok');
    const reconciler = app.get(TriggerReconcilerService);
    const reconcile = jest.spyOn(reconciler, 'reconcile');

    await reconciler.sweepAll(AbortSignal.abort());
    expect(reconcile).not.toHaveBeenCalledWith(wf, { selfHeal: true });
    expect(lines).toContain('log: trigger reconcile sweep: stopped after 0 of 1 workflow(s)');

    await reconciler.sweepAll();
    expect(reconcile).toHaveBeenCalledWith(wf, { selfHeal: true });
  }, 60_000);
  it('a poll job a stop left waiting is taken on the next boot only once DBOS has launched, and its run completes', async () => {
    app = await boot();
    const { wf, activation, lastFire } = await dueSchedule('left to the next boot', '/ok');
    const left = await leaveWaiting('trigger-poll');
    const order: string[] = [];
    const launching = deferred();
    const launch = deferred();
    const bootstrap = DbosLifecycle.prototype.onApplicationBootstrap;
    jest.spyOn(DbosLifecycle.prototype, 'onApplicationBootstrap').mockImplementation(async function (
      this: DbosLifecycle,
    ) {
      launching.resolve();
      await launch.promise;
      await bootstrap.call(this);
      order.push('DBOS launched');
    });

    app = await assemble();
    watchWorkers(app, order);
    const booting = app.init();
    await reached(launching.promise, 'DBOS’s launch');
    expect(order).toEqual([]);
    expect(await jobOf(left)).toMatchObject({ state: 'created', started_on: null });
    expect(await runsOf(wf)).toEqual([]);
    launch.resolve();
    await booting;

    expect(order[0]).toBe('DBOS launched');
    expect(order.slice(1).sort()).toEqual(
      ['run-reap', 'trigger-poll', 'trigger-reconcile', 'trigger-reconcile-sweep'].map((q) => `worker ${q}`),
    );
    const [run] = await eventually(
      'the run complete',
      () => runsOf(wf),
      (rows) => rows[0]?.status === 'completed',
    );
    expect(await workflowStatus(run!.id)).toEqual([{ status: 'SUCCESS' }]);
    const after = await activationOf(activation);
    expect(after.last_error).toBeNull();
    expect(after.cursor).not.toBe(lastFire);
    await eventually(
      'the left job complete',
      () => jobOf(left),
      (job) => job?.state === 'completed',
    );
    expect(lines.filter((line) => SHUT_OUT.test(line))).toEqual([]);
  }, 60_000);

  it.each([
    ['fails', false],
    ['is outlasted by a stop', true],
  ])(
    'a boot whose DBOS launch %s takes no job, and the next boot runs the job’s tick once',
    async (_how, stopped) => {
      app = await boot();
      const { wf, activation, lastFire } = await dueSchedule('no launch', '/ok');
      const left = await leaveWaiting('trigger-poll');
      const order: string[] = [];
      const launching = deferred();
      const launch = jest.spyOn(DBOS, 'launch').mockImplementationOnce(() => {
        launching.resolve();
        return stopped
          ? new Promise<void>(() => undefined)
          : Promise.reject(new Error('system database unreachable'));
      });

      app = await assemble();
      watchWorkers(app, order);
      const booting = app.init();
      if (stopped) {
        booting.catch(() => undefined);
        await reached(launching.promise, 'DBOS’s launch');
      } else {
        await expect(booting).rejects.toThrow('system database unreachable');
      }
      await app.close();
      app = undefined;

      expect(order).toEqual([]);
      expect(await jobOf(left)).toMatchObject({ state: 'created', started_on: null });
      expect(await runsOf(wf)).toEqual([]);
      expect(await activationOf(activation)).toEqual({ last_error: null, cursor: lastFire });
      expect(lines.filter((line) => SHUT_OUT.test(line))).toEqual([]);

      launch.mockRestore();
      app = await boot();
      const [run] = await eventually(
        'the tick run once',
        () => runsOf(wf),
        (rows) => rows[0]?.status === 'completed',
      );
      expect(await runsOf(wf)).toHaveLength(1);
      expect(await workflowStatus(run!.id)).toEqual([{ status: 'SUCCESS' }]);
      expect((await activationOf(activation)).cursor).not.toBe(lastFire);
      await eventually(
        'the left job complete',
        () => jobOf(left),
        (job) => job?.state === 'completed',
      );
    },
    60_000,
  );

  it('an admission waiting for DBOS to launch when the service stops leaves its run recorded and unrefused, as a crash would, logging no failure', async () => {
    const launching = deferred();
    jest.spyOn(DBOS, 'launch').mockImplementationOnce(() => {
      launching.resolve();
      return new Promise<void>(() => undefined);
    });
    app = await assemble();
    app.init().catch(() => undefined);
    await reached(launching.promise, 'DBOS’s launch');
    const runs = app.get(RunsService);
    const runId = randomUUID();
    const ir = doc(
      'admitted before the launch',
      { node_type: 'orchestr:trigger' },
      `${base}/ok`,
    ) as unknown as WorkflowIR;
    const starting = runs
      .startRun({ ir }, { externalUserId: MOCK_USER_ID, runId })
      .catch((err: unknown) => err);
    const scoped = `${MOCK_USER_ID}:${runId}`;
    await eventually(
      'the run recorded',
      () => db.query(`SELECT 1 FROM runtime_runs WHERE id = $1`, [scoped]),
      (r) => r.rowCount === 1,
    );

    await app.close();
    app = undefined;

    expect(await starting).toBeInstanceOf(ShuttingDown);
    expect((await db.query(`SELECT status, error FROM runtime_runs WHERE id = $1`, [scoped])).rows).toEqual([
      { status: 'running', error: null },
    ]);
    expect(lines.filter((line) => SHUT_OUT.test(line))).toEqual([]);
  }, 60_000);

  it('no worker attaches before every module has initialised and the schema guard has passed, so a boot the guard refuses takes no job', async () => {
    app = await boot({ dbos: false });
    const left = await leaveWaiting('trigger-poll');
    const order: string[] = [];
    const bind = SubWorkflowRunnerService.prototype.onModuleInit;
    jest.spyOn(SubWorkflowRunnerService.prototype, 'onModuleInit').mockImplementation(function (
      this: SubWorkflowRunnerService,
    ) {
      order.push('sub-workflow runner bound');
      bind.call(this);
    });
    const guard = SchemaGuard.prototype.onApplicationBootstrap;
    jest.spyOn(SchemaGuard.prototype, 'onApplicationBootstrap').mockImplementation(async function (
      this: SchemaGuard,
    ) {
      order.push('schema guard');
      await guard.call(this);
      order.push('schema guard passed');
    });
    await db.query(`ALTER TABLE composio_webhook_deliveries DROP COLUMN admitted_at`);
    app = await assemble({ dbos: false });
    watchWorkers(app, order);
    await expect(app.init()).rejects.toThrow('schema out of date');
    expect(order).toEqual(['sub-workflow runner bound', 'schema guard']);
    expect(await jobOf(left)).toMatchObject({ state: 'created', started_on: null });
    await app.close();
    app = undefined;

    await db.query(
      `ALTER TABLE composio_webhook_deliveries ADD COLUMN admitted_at timestamp with time zone DEFAULT now()`,
    );
    order.length = 0;
    app = await assemble({ dbos: false });
    watchWorkers(app, order);
    await app.init();
    const firstWorker = order.findIndex((step) => step.startsWith('worker '));
    expect(order.slice(0, firstWorker)).toEqual([
      'sub-workflow runner bound',
      'schema guard',
      'schema guard passed',
    ]);
    expect(order.slice(firstWorker).sort()).toEqual(
      ['run-reap', 'trigger-poll', 'trigger-reconcile', 'trigger-reconcile-sweep'].map((q) => `worker ${q}`),
    );
    await eventually(
      'the left job run',
      () => jobOf(left),
      (job) => job?.state === 'completed',
    );
  }, 60_000);

  it('an MCP call while the stop drains a job in flight is answered 503 with Retry-After and a JSON-RPC error, logging no unhandled error', async () => {
    app = await boot({ dbos: false });
    const held = await holdJob();
    const http = request(app.getHttpServer());

    const closing = app.close();
    app = undefined;
    await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
    const res = await http
      .post('/mcp')
      .set('content-type', 'application/json')
      .set('accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    held.release();
    await closing;

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32000, message: 'The service is stopping; call again once it is back' },
    });
    expect(lines.filter((line) => /Unhandled error|MCP handler has been closed/.test(line))).toEqual([]);
  }, 60_000);

  it('a job still running when the stop’s deadline is up is failed for pg-boss to retry, and the service exits inside the stop’s grace', async () => {
    app = await boot({ dbos: false });
    const { id: stuck } = await holdJob();

    const began = Date.now();
    await app.close();
    const took = Date.now() - began;
    app = undefined;

    expect(took).toBeLessThan(9_500);
    expect(lines).toContain(
      `warn: Shutting down: stopped waiting for job(s) still running 8000 ms into the stop: ${HELD_QUEUE}`,
    );
    expect(await jobOf(stuck)).toMatchObject({
      state: 'retry',
      output: { value: 'pg-boss shut down while active' },
    });
  }, 60_000);

  it('with a durable run still in its step, a job still running at the deadline is failed for pg-boss to retry before DBOS stops to wait for that run, inside the stop’s grace', async () => {
    app = await boot();
    const http = request(app.getHttpServer());
    const wf = (
      await http
        .post('/api/deploy')
        .send({
          workflow_json: doc('durable at the stop', { node_type: 'orchestr:webhook' }, `${base}/gate`),
        })
        .expect(201)
    ).body.workflow_id as string;
    await http.post(`/api/hooks/${wf}/production`).send({}).expect(202);
    await eventually(
      'the run reach its gate',
      () => gate.length,
      (n) => n === 1,
    );
    const { id: stuck } = await holdJob();
    const dbosStopping = deferred();
    let atDbosStop: { ms: number; job: string | undefined } | undefined;
    const began = Date.now();
    const shutdown = DBOS.shutdown.bind(DBOS);
    jest.spyOn(DBOS, 'shutdown').mockImplementation(async (...args) => {
      atDbosStop = { ms: Date.now() - began, job: (await jobOf(stuck))?.state };
      dbosStopping.resolve();
      return shutdown(...args);
    });

    let closed = false;
    const closing = app.close().then(() => (closed = true));
    app = undefined;
    await reached(dbosStopping.promise, 'DBOS’s stop', 15_000);
    expect(atDbosStop!.ms).toBeLessThan(9_500);
    expect(atDbosStop!.job).toBe('retry');
    await new Promise((r) => setTimeout(r, 500));
    expect(closed).toBe(false);
    openGate();
    await closing;

    const [run] = await runsOf(wf);
    expect(run!.status).toBe('completed');
    expect(await workflowStatus(run!.id)).toEqual([{ status: 'SUCCESS' }]);
  }, 60_000);

  it('an agent-step stream open when the service stops ends as the stop begins, one opened while it drains ends at once, and neither holds the rest of the stop', async () => {
    app = await boot({ dbos: false });
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const events = (session: string) =>
      openStream(`http://127.0.0.1:${port}/api/chat/${randomUUID()}/production/events?session_id=${session}`);
    const open = await events('open');
    const held = await holdJob();
    const runs = app.get(RunsService);
    const runsStop = jest.spyOn(runs, 'onApplicationShutdown');

    const closing = app.close();
    app = undefined;
    await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
    await reached(
      open.ended.then(() => undefined),
      'the open stream’s end',
    );
    const during = await events('during');
    await reached(
      during.ended.then(() => undefined),
      'the end of the stream opened during the stop',
    );
    const released = Date.now();
    held.release();
    await closing;

    expect(Date.now() - released).toBeLessThan(3_000);
    expect([open.status, during.status]).toEqual([200, 200]);
    expect([await open.ended, await during.ended]).toEqual([true, true]);
    expect(runsStop).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('a synchronous run request still open at the stop’s deadline is cut off, so the stop goes on and the service exits inside its grace', async () => {
    const service = await bootService({
      service: THIS_SERVICE,
      databaseUrl,
      env: { DBOS_ENABLED: 'false', PGBOSS_ENABLED: 'true' },
    });
    lockers.push(() => service.crash());
    const sync = fetch(`${service.base}/api/runs/from-ir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow_ir: doc('sync at the stop', { node_type: 'orchestr:trigger' }, `${base}/gate`),
      }),
    }).then(
      (res) => `answered ${res.status}`,
      (err: unknown) => String(err),
    );
    await eventually(
      'the run reach its gate',
      () => gate.length,
      (n) => n === 1,
    );

    const began = Date.now();
    await service.terminate();
    const took = Date.now() - began;

    expect(took).toBeLessThan(9_500);
    expect(await sync).toMatch(/fetch failed/);
    expect(service.log()).toMatch(
      /Shutting down: stopped waiting for in-process run\(s\) still going 8000 ms into the stop: /,
    );
  }, 60_000);

  it('an orchestr_test_workflow call waiting on its run when the service stops is answered with its run handle at once, and the stop goes on', async () => {
    app = await boot({ dbos: false });
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const client = new McpClient({ name: 'jobs-shutdown-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    lockers.push(() => client.close());
    const calling = client.callTool({
      name: 'orchestr_test_workflow',
      arguments: {
        workflow_ir: doc('tested at the stop', { node_type: 'orchestr:trigger' }, `${base}/gate`),
        await_ms: 30_000,
      },
    });
    await eventually(
      'the run reach its gate',
      () => gate.length,
      (n) => n === 1,
    );

    const began = Date.now();
    const closing = app.close();
    app = undefined;
    const answered = await calling;
    const answeredMs = Date.now() - began;
    const runsWait = await eventually(
      'the stop wait on its in-process run',
      () => lines.find((line) => line.includes('in-process run(s) to end or park')),
      (line) => line !== undefined,
    );
    openGate();
    await closing;

    expect(answeredMs).toBeLessThan(2_000);
    expect(answered.isError).toBeFalsy();
    expect(answered.structuredContent).toMatchObject({ status: 'running', run_id: expect.any(String) });
    // The HTTP server closed at once, its connection dropped as the answer ended, so the run wait has the deadline left.
    expect(Number(/waiting up to (\d+) ms/.exec(runsWait!)![1])).toBeGreaterThan(7_000);
    const { run_id: runId } = answered.structuredContent as { run_id: string };
    expect(
      (await db.query(`SELECT status FROM runtime_runs WHERE id = $1`, [`${MOCK_USER_ID}:${runId}`])).rows,
    ).toEqual([{ status: 'completed' }]);
  }, 60_000);

  it('a job fetched for its retry as the stop began is handed back to its queue with only the retries it had left, and runs on the next boot', async () => {
    app = await boot({ dbos: false });
    const boss = app.get<PgBoss>(PG_BOSS);
    let attempts = 0;
    await app.get(JobRegistry).register(async (queues) => {
      await queues.createQueue(LATE_QUEUE);
      await queues.work(LATE_QUEUE, () => {
        attempts += 1;
        return Promise.reject(new Error('its first attempt fails'));
      });
    });
    const retryFetch = holdFetch(LATE_QUEUE, {
      ready: async () => (await jobsOf(LATE_QUEUE))[0]?.state === 'retry',
    });
    const late = (await boss.send(LATE_QUEUE, { n: 'caught' }, { retryLimit: 2, retryDelay: 0 }))!;
    await reached(retryFetch.fetching, 'the late job’s retry fetch', 10_000);
    const held = await holdJob();

    const closing = app.close();
    app = undefined;
    await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
    retryFetch.release();
    const handedBack = await eventually(
      'the caught job handed back',
      () => jobsOf(LATE_QUEUE),
      (rows) => rows.length === 2 && rows[0]!.state === 'completed',
    );
    held.release();
    await closing;

    const copy = handedBack[1]!.id;
    expect(attempts).toBe(1);
    expect(handedBack).toEqual([
      {
        id: late,
        state: 'completed',
        data: { n: 'caught' },
        retry_limit: 2,
        retry_count: 1,
        singleton_key: null,
      },
      {
        id: copy,
        state: 'created',
        data: { n: 'caught' },
        retry_limit: 1,
        retry_count: 0,
        singleton_key: null,
      },
    ]);
    expect(lines).toContain(
      `log: Shutting down: handed ${LATE_QUEUE} job ${late} back to its queue as job ${copy}`,
    );

    app = await boot({ dbos: false });
    const ran = deferred();
    const seen: unknown[] = [];
    await app.get(JobRegistry).register((queues) =>
      queues.work(LATE_QUEUE, ([job]) => {
        seen.push(job!.data);
        ran.resolve();
        return Promise.resolve();
      }),
    );
    await reached(ran.promise, 'the handed-back job', 10_000);
    expect(seen).toEqual([{ n: 'caught' }]);
    await eventually(
      'the handed-back job complete',
      () => jobOf(copy),
      (job) => job?.state === 'completed',
    );
  }, 60_000);

  it.each([
    ['is handed back keeping its singleton key', false],
    ['is left to the job its key already has waiting, sent while it was fetched', true],
  ])(
    'a job of a short-policy queue sent with a singleton key and fetched as the stop began %s',
    async (_outcome, keyTaken) => {
      app = await boot({ dbos: false });
      const boss = app.get<PgBoss>(PG_BOSS);
      await app.get(JobRegistry).register(async (queues) => {
        await queues.createQueue(SHORT_QUEUE);
        await queues.updateQueue(SHORT_QUEUE, { name: SHORT_QUEUE, policy: 'short' });
        await queues.work(SHORT_QUEUE, () => Promise.reject(new Error('a job the stop caught ran')));
      });
      const key = randomUUID();
      let waiting: string | null = null;
      const fetch = holdFetch(SHORT_QUEUE, {
        fetched: async () => {
          if (keyTaken)
            waiting = await boss.send(SHORT_QUEUE, { n: 'sent meanwhile' }, { singletonKey: key });
        },
      });
      await reached(fetch.fetching, 'the short queue’s next fetch', 10_000);
      const caught = (await boss.send(SHORT_QUEUE, { n: 'caught' }, { singletonKey: key }))!;
      const held = await holdJob();

      const closing = app.close();
      app = undefined;
      await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
      fetch.release();
      const after = await eventually(
        'the caught job handed back',
        () => jobsOf(SHORT_QUEUE),
        (rows) => rows.length === 2 && rows[0]!.state === 'completed',
      );
      held.release();
      await closing;

      const second = after[1]!.id;
      const kept = { retry_limit: 2, retry_count: 0, singleton_key: key };
      expect(after).toEqual([
        { id: caught, state: 'completed', data: { n: 'caught' }, ...kept },
        { id: second, state: 'created', data: { n: keyTaken ? 'sent meanwhile' : 'caught' }, ...kept },
      ]);
      expect(lines).toContain(
        keyTaken
          ? `log: Shutting down: left ${SHORT_QUEUE} job ${caught} to the job already waiting in its queue`
          : `log: Shutting down: handed ${SHORT_QUEUE} job ${caught} back to its queue as job ${second}`,
      );
      if (keyTaken) expect(second).toBe(waiting);
    },
    60_000,
  );

  it('while the stop drains a job, a connection kept alive from before it still serves, and every answer from then on closes its connection', async () => {
    app = await boot({ dbos: false });
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const reused = new Agent({ keepAlive: true, maxSockets: 1 });
    const idle = new Agent({ keepAlive: true, maxSockets: 1 });
    lockers.push(() => {
      reused.destroy();
      idle.destroy();
      return Promise.resolve();
    });
    const health = (agent: Agent) =>
      new Promise<{ status: number; connection: string | undefined; reused: boolean }>((resolve, reject) => {
        const req = get({ host: '127.0.0.1', port, path: '/api/health', agent }, (res) => {
          res.resume();
          res.once('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              connection: res.headers.connection,
              reused: req.reusedSocket,
            }),
          );
        });
        req.once('error', reject);
      });
    const held = await holdJob();
    const keptAlive = { status: 200, connection: 'keep-alive', reused: false };
    expect([await health(reused), await health(idle)]).toEqual([keptAlive, keptAlive]);

    const closing = app.close();
    app = undefined;
    await eventually('the stop wait on its jobs', stopWaitedOnJobs, Boolean);
    const during: unknown[] = [];
    for (let i = 0; i < 20; i++) during.push(await health(reused).catch((err: unknown) => String(err)));
    const fromBefore = await health(idle).catch((err: unknown) => String(err));
    held.release();
    await closing;

    const closed = { status: 200, connection: 'close' };
    expect(during).toEqual([
      { ...closed, reused: true },
      ...Array.from({ length: 19 }, () => ({ ...closed, reused: false })),
    ]);
    expect(fromBefore).toEqual({ ...closed, reused: true });
  }, 60_000);

  it('a job a worker’s fetch takes at the database once pg-boss has stopped is handed back before its database closes, keeping its retries', async () => {
    app = await boot({ dbos: false });
    const boss = app.get<PgBoss>(PG_BOSS);
    const registry = app.get(JobRegistry);
    await registry.register((queues) => queues.createQueue(FETCHED_QUEUE));
    const fetchedLate = (await boss.send(FETCHED_QUEUE, { n: 'fetched late' }, { retryLimit: 2 }))!;
    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE pgboss.job IN EXCLUSIVE MODE');
    const unlock = (): Promise<void> => locker.query('COMMIT').then(async () => locker.end());
    let unlocked: Promise<void> | undefined;
    lockers.push(() => (unlocked ??= unlock()));
    const pgboss = boss.getDb();
    const execute = pgboss.executeSql.bind(pgboss);
    const fetching = deferred();
    jest.spyOn(pgboss, 'executeSql').mockImplementation((text, values) => {
      if (text.includes('SKIP LOCKED') && values?.[0] === FETCHED_QUEUE) fetching.resolve();
      return execute(text, values);
    });
    let ran = 0;
    await registry.register((queues) =>
      queues.work(FETCHED_QUEUE, () => {
        ran += 1;
        return Promise.resolve();
      }),
    );
    await reached(fetching.promise, 'the fetch of the queue', 10_000);
    // pg-boss's stop queues its shutdown in a setImmediate before any I/O, so two ticks on it has kept or closed its database.
    const stop = boss.stop.bind(boss);
    const stopped = deferred();
    jest.spyOn(boss, 'stop').mockImplementation((options) => {
      const stopping = stop(options);
      setImmediate(() => setImmediate(stopped.resolve));
      return stopping;
    });

    const closing = app.close();
    app = undefined;
    await reached(stopped.promise, 'pg-boss’s stop', 15_000);
    await (unlocked ??= unlock());
    await closing;

    expect(ran).toBe(0);
    const after = await jobsOf(FETCHED_QUEUE);
    const kept = { data: { n: 'fetched late' }, retry_limit: 2, retry_count: 0, singleton_key: null };
    expect(after).toEqual([
      { id: fetchedLate, state: 'completed', ...kept },
      { id: expect.any(String), state: 'created', ...kept },
    ]);
    expect(lines).toContain(
      `log: Shutting down: handed ${FETCHED_QUEUE} job ${fetchedLate} back to its queue as job ${after[1]!.id}`,
    );
  }, 60_000);

  it.each([
    ['its head side', false],
    ['both its sides', true],
  ])(
    'a review test whose admission the stopping service refuses on %s keeps no result, and leaves the merge gate as it was',
    async (_sides, both) => {
      app = await boot();
      const http = () => request(app!.getHttpServer());
      const wf = (
        await http()
          .post('/api/deploy')
          .send({ workflow_json: doc('tested at the stop', { node_type: 'orchestr:trigger' }, `${base}/ok`) })
          .expect(201)
      ).body.workflow_id as string;
      await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({
          workflow_ir: doc('tested at the stop', { node_type: 'orchestr:trigger' }, `${base}/ok?lane`),
          branch: 'lane',
        })
        .expect(201);
      await http()
        .patch(`/api/workflows/${wf}/branches/main/protection`)
        .send({ is_protected: true })
        .expect(200);
      const review = (
        await http()
          .post(`/api/workflows/${wf}/reviews`)
          .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
          .expect(201)
      ).body.id as string;

      const runs = app.get(RunsService);
      const runsStopping = deferred();
      const held = (plan: unknown): boolean => both || JSON.stringify(plan).includes('ok?lane');
      const arrived = { held: 0, admitted: deferred() };
      const admit = runs.admit.bind(runs);
      jest.spyOn(runs, 'admit').mockImplementation(async (plan, opts) => {
        if (!held(plan)) {
          const admitting = admit(plan, opts);
          void admitting.then(arrived.admitted.resolve, () => undefined);
          return admitting;
        }
        arrived.held += 1;
        await runsStopping.promise;
        return admit(plan, opts);
      });
      const reviewTest = app.get(ReviewTestService);
      const testBranch = reviewTest.testBranch.bind(reviewTest);
      let tested: Promise<unknown> | undefined;
      jest.spyOn(reviewTest, 'testBranch').mockImplementation((...args) => (tested = testBranch(...args)));
      const stop = runs.onApplicationShutdown.bind(runs);
      jest.spyOn(runs, 'onApplicationShutdown').mockImplementation(async () => {
        const stopping = stop();
        runsStopping.resolve();
        await tested?.catch(() => undefined);
        return stopping;
      });

      const port = (app.getHttpServer().address() as AddressInfo).port;
      const testing = send({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/workflows/${wf}/reviews/${review}/test`,
        headers: { 'content-type': 'application/json' },
      });
      testing.on('error', () => undefined);
      testing.end(JSON.stringify({ trigger_payload: {} }));
      if (!both) await reached(arrived.admitted.promise, 'the base side’s admission', 10_000);
      await eventually(
        'the held sides at their admission',
        () => arrived.held,
        (n) => n === (both ? 2 : 1),
      );
      // Its caller gone, the review test outlives the HTTP server's close.
      app.get(ShutdownDeadline).signal.addEventListener('abort', () => testing.destroy());

      await app.close();
      app = undefined;

      expect(
        (await db.query(`SELECT verdict FROM review_test_results WHERE review_id = $1`, [review])).rows,
      ).toEqual([]);
      expect((await db.query(`SELECT status FROM runtime_runs WHERE review_id = $1`, [review])).rows).toEqual(
        both ? [] : [{ status: 'completed' }],
      );
      app = await boot();
      const shown = (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body;
      expect({ blocked: shown.merge_blocked_by_test, lastTest: shown.last_test }).toEqual({
        blocked: null,
        lastTest: null,
      });
    },
    60_000,
  );
});
