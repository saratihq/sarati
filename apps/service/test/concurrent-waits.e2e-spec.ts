import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** One wait in a run: on `topic` it waits on a person, without one it sleeps on its own clock. */
interface Wait {
  id: string;
  topic?: string;
}

type Http = () => ReturnType<typeof request>;

/** How a run of independent waits reaches the engine, and the step key each wait runs under. */
interface Rail {
  name: string;
  dbos: boolean;
  /** How long a timer in these runs sleeps — long enough to park. */
  timerMs: number;
  start(http: Http, runId: string, waits: Wait[]): Promise<Response>;
  stepKey(waits: Wait[], id: string): string;
}

const APPROVAL_WINDOW_MS = 10 * 60_000;

/** An authored workflow whose waits are unconnected roots — the shape the canvas saves — run through from-ir. */
const authored: Rail = {
  name: 'an authored workflow, in process (DBOS off)',
  dbos: false,
  timerMs: 2 * 60_000,
  start: (http, runId, waits) =>
    http()
      .post('/api/runs/from-ir')
      .send({
        run_id: runId,
        workflow_ir: {
          version: '1.0',
          name: runId,
          description: '',
          nodes: waits.map((w, i) => ({
            id: w.id,
            name: w.id,
            node_type: w.topic ? 'orchestr:wait_for_event' : 'orchestr:wait_for_duration',
            type_version: 1,
            parameters: w.topic
              ? { topic: w.topic, timeout_ms: APPROVAL_WINDOW_MS }
              : { amount: 2, unit: 'minutes' },
            position: { x: 0, y: i * 120 },
            metadata: {},
          })),
          edges: [],
          settings: { execution_order: 'v1', extra: {} },
          metadata: {},
        },
      })
      .then((res) => res),
  stepKey: (_waits, id) => id,
};

/** A raw plan forking its waits into parallel branches, run durably. */
const durable: Rail = {
  name: 'a raw plan, durably (DBOS on)',
  dbos: true,
  timerMs: 61_000,
  start: (http, runId, waits) =>
    http()
      .post('/api/runs')
      .send({
        run_id: runId,
        plan: {
          id: `plan-${runId}`,
          nodes: [
            {
              kind: 'parallel',
              id: 'fork',
              branches: waits.map((w) => [
                w.topic
                  ? { kind: 'waitForEvent', id: w.id, topic: w.topic, timeoutMs: APPROVAL_WINDOW_MS }
                  : { kind: 'delay', id: w.id, ms: 61_000 },
              ]),
            },
          ],
        },
      })
      .then((res) => res),
  stepKey: (waits, id) => `fork|${waits.findIndex((w) => w.id === id)}/${id}`,
};

describe.each([authored, durable])('waits parked at once: $name (e2e, isolated DB, mock auth)', (rail) => {
  let app: INestApplication;
  let db: Client;
  let both: Promise<Response>;

  const http: Http = () => request(app.getHttpServer());
  const BOTH: Wait[] = [{ id: 'pause' }, { id: 'approve', topic: 'approval' }];
  const pauseKey = rail.stepKey(BOTH, 'pause');
  const approveKey = rail.stepKey(BOTH, 'approve');
  const timerTopic = `orchestr:timer:${pauseKey}`;

  async function eventually<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}`);
  }

  /** The inbox entries for one run, in inbox order. */
  async function inboxFor(runId: string): Promise<Array<Record<string, unknown>>> {
    const res = await http().get('/api/runs/waiting').expect(200);
    return (res.body.runs as Array<Record<string, unknown>>).filter((r) => r.run_id === runId);
  }

  /** The run's status, and each of its parked steps' topic, by step key. */
  async function parkedIn(runId: string): Promise<{ status: string; parked: Record<string, string> }> {
    const run = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM runtime_runs WHERE run_id = $1`,
      [runId],
    );
    const steps = await db.query<{ step_key: string; waiting_topic: string }>(
      `SELECT step_key, waiting_topic FROM runtime_run_steps WHERE run_id = $1 AND waiting_topic IS NOT NULL`,
      [run.rows[0]?.id],
    );
    return {
      status: run.rows[0]?.status ?? 'missing',
      parked: Object.fromEntries(steps.rows.map((s) => [s.step_key, s.waiting_topic])),
    };
  }

  async function deadlineOf(runId: string, stepKey: string): Promise<string> {
    const res = await db.query<{ waiting_timeout_at: Date }>(
      `SELECT s.waiting_timeout_at FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
        WHERE r.run_id = $1 AND s.step_key = $2`,
      [runId, stepKey],
    );
    return res.rows[0]!.waiting_timeout_at.toISOString();
  }

  const answer = (runId: string, topic: string, payload: unknown, stepKey?: string) =>
    http()
      .post(`/api/runs/${runId}/events`)
      .send({ topic, payload, ...(stepKey ? { step_key: stepKey } : {}) });

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    // Held open for the whole sleep: a database with no live backend is reaped by other suites.
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = String(rail.dbos);
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    both = rail.start(http, 'both', BOTH);
    await eventually(
      () => parkedIn('both'),
      (s) => Object.keys(s.parked).length === 2,
      'the timer and the approval both parked',
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it('parks the timer and the approval side by side, and lists only the approval', async () => {
    expect(await parkedIn('both')).toEqual({
      status: 'waiting',
      parked: { [pauseKey]: timerTopic, [approveKey]: 'approval' },
    });

    const listed = await inboxFor('both');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      step_key: approveKey,
      node_id: 'approve',
      topic: 'approval',
      timeout_at: await deadlineOf('both', approveKey),
    });

    const detail = await http().get('/api/runs/both').expect(200);
    expect(detail.body.status).toBe('waiting');
    expect(detail.body.waiting).toEqual({ kind: 'event', until: await deadlineOf('both', approveKey) });
    const waitingOf = (key: string): unknown =>
      (detail.body.steps as Array<{ step_key: string; waiting: unknown }>).find((s) => s.step_key === key)
        ?.waiting;
    expect(waitingOf(pauseKey)).toEqual({ kind: 'timer', until: await deadlineOf('both', pauseKey) });
    expect(waitingOf(approveKey)).toEqual({ kind: 'event', until: await deadlineOf('both', approveKey) });
  });

  it('refuses an event no parked wait is on, naming what the run does wait on, and parks on', async () => {
    const toTimer = await answer('both', timerTopic, {});
    expect(toTimer.status).toBe(409);
    expect(toTimer.body).toMatchObject({
      code: 'timer_wait',
      detail: `Topic "${timerTopic}" belongs to a timed wait and can't be sent to`,
    });

    const elsewhere = await answer('both', 'nope', {});
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.detail).toBe('Run both is waiting on topic "approval", not "nope"');

    expect(Object.keys((await parkedIn('both')).parked).sort()).toEqual([approveKey, pauseKey].sort());
  });

  it('takes the decision while the timer sleeps on, and then waits only on the timer', async () => {
    await answer('both', 'approval', { decision: 'approved' }).expect(200);

    // The claim unparks the wait before the run takes the event, so wait for the step itself to finish.
    const approvedIn = (body: Record<string, unknown>): Record<string, unknown> | undefined =>
      (body.steps as Array<Record<string, unknown>>).find((s) => s.step_key === approveKey);
    const detail = await eventually(
      async () => (await http().get('/api/runs/both').expect(200)).body as Record<string, unknown>,
      (body) => approvedIn(body)?.status !== 'running',
      'the approval step finished',
    );
    expect(approvedIn(detail)).toMatchObject({
      status: 'completed',
      output: { decision: 'approved' },
      waiting: null,
    });
    expect(detail.waiting).toEqual({ kind: 'timer', until: await deadlineOf('both', pauseKey) });
    expect(await parkedIn('both')).toEqual({ status: 'waiting', parked: { [pauseKey]: timerTopic } });
    expect(await inboxFor('both')).toEqual([]);

    const again = await answer('both', 'approval', { decision: 'rejected' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('timer_wait');
    expect(again.body.detail).toMatch(
      /^Run both is waiting until \d{4}-\d\d-\d\dT[\d:.]+Z, not for an event — it resumes on its own$/,
    );
  });

  it('lists two approvals on different topics apart, and answers each on its own', async () => {
    const waits: Wait[] = [
      { id: 'legal', topic: 'legal' },
      { id: 'finance', topic: 'finance' },
    ];
    const pair = rail.start(http, 'pair', waits);
    const listed = await eventually(
      () => inboxFor('pair'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );
    expect(listed.map((r) => [r.step_key, r.topic]).sort()).toEqual(
      [
        [rail.stepKey(waits, 'finance'), 'finance'],
        [rail.stepKey(waits, 'legal'), 'legal'],
      ].sort(),
    );

    await answer('pair', 'finance', { decision: 'approved' }).expect(200);
    const left = await eventually(
      () => inboxFor('pair'),
      (rows) => rows.length === 1,
      'finance off the inbox',
    );
    expect(left[0]).toMatchObject({ topic: 'legal' });
    expect((await parkedIn('pair')).status).toBe('waiting');

    await answer('pair', 'legal', { decision: 'rejected' }).expect(200);
    const done = await pair;
    expect(done.status).toBe(201);
    expect(done.body.outputs).toMatchObject({
      finance: { decision: 'approved' },
      legal: { decision: 'rejected' },
    });
    expect(await parkedIn('pair')).toEqual({ status: 'completed', parked: {} });
  });

  it('parks two approvals on one topic at once; one naming its step answers only that, one naming the topic the oldest', async () => {
    const waits: Wait[] = [
      { id: 'first', topic: 'approval' },
      { id: 'second', topic: 'approval' },
    ];
    const [firstKey, secondKey] = [rail.stepKey(waits, 'first'), rail.stepKey(waits, 'second')];
    const same = rail.start(http, 'same', waits);
    const listed = await eventually(
      () => inboxFor('same'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );
    expect(listed.map((r) => r.step_key).sort()).toEqual([firstKey, secondKey].sort());

    await answer('same', 'approval', { decision: 'two' }, secondKey).expect(200);
    const left = await eventually(
      () => inboxFor('same'),
      (rows) => rows.length === 1,
      'the named one answered',
    );
    expect(left[0]).toMatchObject({ step_key: firstKey });

    await answer('same', 'approval', { decision: 'one' }).expect(200);
    const done = await same;
    expect(done.status).toBe(201);
    expect(done.body.outputs).toMatchObject({ first: { decision: 'one' }, second: { decision: 'two' } });
  });

  it('takes one of two events naming the same wait at once, and leaves the other wait for a person', async () => {
    const waits: Wait[] = [
      { id: 'first', topic: 'approval' },
      { id: 'second', topic: 'approval' },
    ];
    const [firstKey, secondKey] = [rail.stepKey(waits, 'first'), rail.stepKey(waits, 'second')];
    const twice = rail.start(http, 'twice', waits);
    await eventually(
      () => inboxFor('twice'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );

    const sent = await Promise.all([
      answer('twice', 'approval', { decision: 'a' }, firstKey),
      answer('twice', 'approval', { decision: 'b' }, firstKey),
    ]);
    expect(sent.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sent.find((r) => r.status === 409)!.body.detail).toBe(
      `Run twice is no longer waiting at step "${firstKey}"`,
    );
    await new Promise((r) => setTimeout(r, 500));
    expect((await inboxFor('twice')).map((r) => r.step_key)).toEqual([secondKey]);

    await answer('twice', 'approval', { decision: 'c' }, secondKey).expect(200);
    const done = await twice;
    expect(done.status).toBe(201);
    expect(done.body.outputs.second).toEqual({ decision: 'c' });
    expect(['a', 'b']).toContain((done.body.outputs.first as { decision: string }).decision);
  });

  it('refuses a decision from a row already answered, instead of handing it to the next wait on the topic', async () => {
    const waits: Wait[] = [
      { id: 'first', topic: 'approval' },
      { id: 'second', topic: 'approval' },
    ];
    const [firstKey, secondKey] = [rail.stepKey(waits, 'first'), rail.stepKey(waits, 'second')];
    const stale = rail.start(http, 'stale', waits);
    await eventually(
      () => inboxFor('stale'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );

    await answer('stale', 'approval', { decision: 'approved' }, firstKey).expect(200);
    await eventually(
      () => inboxFor('stale'),
      (rows) => rows.length === 1,
      'the first answered',
    );
    const late = await answer('stale', 'approval', { decision: 'rejected' }, firstKey);
    expect(late.status).toBe(409);
    expect(late.body.detail).toBe(`Run stale is no longer waiting at step "${firstKey}"`);
    expect((await inboxFor('stale')).map((r) => r.step_key)).toEqual([secondKey]);

    await answer('stale', 'approval', { decision: 'second' }, secondKey).expect(200);
    const done = await stale;
    expect(done.body.outputs).toMatchObject({
      first: { decision: 'approved' },
      second: { decision: 'second' },
    });
  });

  it(
    'wakes the timer on its own, and the run completes with the decision',
    async () => {
      const woke = await both;
      expect(woke.status).toBe(201);
      expect(woke.body.outputs.approve).toEqual({ decision: 'approved' });

      const detail = await eventually(
        async () => (await http().get('/api/runs/both').expect(200)).body as Record<string, unknown>,
        (d) => d.status === 'completed',
        'the run completed',
      );
      expect(detail.waiting).toBeNull();
      const paused = (detail.steps as Array<Record<string, unknown>>).find((s) => s.step_key === pauseKey);
      expect(paused).toMatchObject({ kind: 'delay', status: 'completed', waiting: null });
      const due = Date.parse((paused!.output as { slept_until: string }).slept_until);
      const wokeAt = Date.parse(paused!.finished_at as string);
      expect(wokeAt).toBeGreaterThanOrEqual(due);
      // On an idle machine it lands within ~200ms; the margin is for a loaded one, far short of any 5-minute sweep.
      expect(wokeAt - due).toBeLessThan(60_000);
      expect(await parkedIn('both')).toEqual({ status: 'completed', parked: {} });
    },
    // The timer started in beforeAll; the budget only has to outlast it, and the wake is held to time above.
    rail.timerMs + 120_000,
  );
});
