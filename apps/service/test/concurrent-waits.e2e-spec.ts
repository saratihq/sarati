import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { eventTopicFor } from '../src/runtime/event-wait';
import { RunRecorderService } from '../src/runtime/run-recorder.service';
import { PARK_DELAY_ABOVE_MS } from '../src/runtime/timer-wait';
import { listenOnLoopback } from './support/listen';
import { deferred, holdResume, pause, reached, type Deferred } from './support/lock-probes';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** One wait in a run: on `topic` it waits on a person, without one it sleeps on its own clock. */
interface Wait {
  id: string;
  topic?: string;
  /** An approval's window; the suite's default when unset. */
  windowMs?: number;
}

type Http = () => ReturnType<typeof request>;

/** Waits one after another, or one wait inside a loop that runs a single round. */
type Shape = 'sequence' | 'loop';

/** How a run of independent waits reaches the engine, and the step key each wait runs under. */
interface Rail {
  name: string;
  dbos: boolean;
  /** How long a timer in these runs sleeps — long enough to park. */
  timerMs: number;
  start(http: Http, runId: string, waits: Wait[]): Promise<Response>;
  stepKey(waits: Wait[], id: string): string;
  startShape(http: Http, runId: string, shape: Shape, waits: Wait[]): Promise<Response>;
}

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

const irWait = (w: Wait, i: number) => ({
  id: w.id,
  name: w.id,
  node_type: 'orchestr:wait_for_event',
  type_version: 1,
  parameters: { topic: w.topic, timeout_ms: w.windowMs ?? APPROVAL_WINDOW_MS },
  position: { x: 0, y: i * 120 },
  metadata: {},
});
const irEdge = (source: string, target: string) => ({
  id: `${source}->${target}`,
  source_node_id: source,
  source_port: 0,
  target_node_id: target,
  target_port: 0,
  port_type: 'main',
});
const irLoop = {
  id: 'lp',
  name: 'lp',
  node_type: 'orchestr:loop',
  type_version: 1,
  parameters: { mode: 'while', condition: { left: 'a', op: 'eq', right: 'b' }, max_iterations: 1 },
  position: { x: 0, y: 0 },
  metadata: {},
};

const APPROVAL_WINDOW_MS = 10 * 60_000;
const PARK_HELD_MS = 3_000;

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
              ? { topic: w.topic, timeout_ms: w.windowMs ?? APPROVAL_WINDOW_MS }
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
  startShape: (http, runId, shape, waits) =>
    http()
      .post('/api/runs/from-ir')
      .send({
        run_id: runId,
        workflow_ir: {
          version: '1.0',
          name: runId,
          description: '',
          nodes: shape === 'loop' ? [irLoop, ...waits.map(irWait)] : waits.map(irWait),
          edges:
            shape === 'loop'
              ? waits.map((w) => irEdge('lp', w.id))
              : waits.slice(1).map((w, i) => irEdge(waits[i]!.id, w.id)),
          settings: { execution_order: 'v1', extra: {} },
          metadata: {},
        },
      })
      .then((res) => res),
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
                  ? {
                      kind: 'waitForEvent',
                      id: w.id,
                      topic: w.topic,
                      timeoutMs: w.windowMs ?? APPROVAL_WINDOW_MS,
                    }
                  : { kind: 'delay', id: w.id, ms: 61_000 },
              ]),
            },
          ],
        },
      })
      .then((res) => res),
  stepKey: (waits, id) => `fork|${waits.findIndex((w) => w.id === id)}/${id}`,
  startShape: (http, runId, shape, waits) => {
    const nodes = waits.map((w) => ({
      kind: 'waitForEvent',
      id: w.id,
      topic: w.topic,
      timeoutMs: w.windowMs ?? APPROVAL_WINDOW_MS,
    }));
    return http()
      .post('/api/runs')
      .send({
        run_id: runId,
        plan: {
          id: `plan-${runId}`,
          nodes:
            shape === 'loop'
              ? [
                  { kind: 'code', id: 'rounds', language: 'js', code: 'return [1];' },
                  { kind: 'forEach', id: 'lp', items: '{{rounds}}', itemVar: 'item', body: nodes },
                ]
              : nodes,
        },
      })
      .then((res) => res);
  },
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

    const wrongTopic = await answer('both', 'nope', {}, approveKey);
    expect(wrongTopic.status).toBe(409);
    expect(wrongTopic.body.detail).toBe(`Step "${approveKey}" of run both waits on "approval", not "nope"`);
    const atTimer = await answer('both', 'approval', {}, pauseKey);
    expect(atTimer.status).toBe(409);
    expect(atTimer.body).toMatchObject({
      code: 'timer_wait',
      detail: `Step "${pauseKey}" of run both is a timed wait; it can't be sent to`,
    });

    expect(Object.keys((await parkedIn('both')).parked).sort()).toEqual([approveKey, pauseKey].sort());
  });

  it('takes the decision while the timer sleeps on, and then waits only on the timer', async () => {
    await answer('both', 'approval', { decision: 'approved' }).expect(200);

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

    const neither = await answer('pair', 'nope', {});
    expect(neither.body.detail).toBe('Run pair is waiting on topics "finance", "legal", not "nope"');

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
    // Refused as decided while the first is on its way, as gone once the run has taken it.
    expect([
      `Step "${firstKey}" of run twice is already decided`,
      `Run twice is no longer waiting at step "${firstKey}"`,
    ]).toContain(sent.find((r) => r.status === 409)!.body.detail);
    await new Promise((r) => setTimeout(r, 500));
    expect((await inboxFor('twice')).map((r) => r.step_key)).toEqual([secondKey]);

    await answer('twice', 'approval', { decision: 'c' }, secondKey).expect(200);
    const done = await twice;
    expect(done.status).toBe(201);
    expect(done.body.outputs.second).toEqual({ decision: 'c' });
    expect(['a', 'b']).toContain((done.body.outputs.first as { decision: string }).decision);
  });

  it('hands two events naming only the topic, sent at once, to two different waits on it', async () => {
    const waits: Wait[] = [
      { id: 'first', topic: 'approval' },
      { id: 'second', topic: 'approval' },
    ];
    const both = rail.start(http, 'topics', waits);
    await eventually(
      () => inboxFor('topics'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );

    const sent = await Promise.all([
      answer('topics', 'approval', { decision: 'x' }),
      answer('topics', 'approval', { decision: 'y' }),
    ]);
    expect(sent.map((r) => r.status)).toEqual([200, 200]);
    const done = await both;
    expect(done.status).toBe(201);
    const decisions = [done.body.outputs.first, done.body.outputs.second].map(
      (o) => (o as { decision: string }).decision,
    );
    expect(decisions.sort()).toEqual(['x', 'y']);
  });

  it('refuses a decision that could reach the run only after its wait times out', async () => {
    const waits: Wait[] = [{ id: 'brief', topic: 'approval', windowMs: 3_000 }];
    const late = rail.start(http, 'late', waits);
    const [row] = await eventually(
      () => inboxFor('late'),
      (rows) => rows.length === 1,
      'the approval listed',
    );
    const deadline = Date.parse(row!.timeout_at as string);
    await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now() - 1_000)));

    const refused = await answer('late', 'approval', { decision: 'too late' }, rail.stepKey(waits, 'brief'));
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toBe(
      `Run late is no longer taking a decision at step "${rail.stepKey(waits, 'brief')}" — the wait times out within 2s`,
    );
    const done = await late;
    expect(done.status).toBe(201);
    expect(done.body.outputs.brief).toBeNull();
    expect((await http().get('/api/runs/late').expect(200)).body.decided_by).toBeNull();
  });

  it('passes a topic-only event over a wait in its last two seconds to the next one still open, and lists only that', async () => {
    const waits: Wait[] = [
      { id: 'brief', topic: 'approval', windowMs: 3_000 },
      { id: 'later', topic: 'approval' },
    ];
    const [briefKey, laterKey] = [rail.stepKey(waits, 'brief'), rail.stepKey(waits, 'later')];
    const run = rail.start(http, 'passover', waits);
    const rows = await eventually(
      () => inboxFor('passover'),
      (listed) => listed.length === 2,
      'both approvals listed',
    );
    const deadline = Date.parse(rows.find((r) => r.step_key === briefKey)!.timeout_at as string);
    await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now() - 1_000)));

    expect((await inboxFor('passover')).map((r) => r.step_key)).toEqual([laterKey]);
    expect((await answer('passover', 'approval', { d: 'next' }).expect(200)).body).toEqual({
      status: 'sent',
      step_key: laterKey,
    });
    expect((await run).body.outputs).toMatchObject({ brief: null, later: { d: 'next' } });
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

    const [run] = (await db.query<{ id: string }>(`SELECT id FROM runtime_runs WHERE run_id = $1`, ['stale']))
      .rows;
    const take = holdResume(app.get(RunRecorderService), {
      match: (scoped, stepKey) => scoped === run!.id && stepKey === firstKey,
    });
    try {
      await answer('stale', 'approval', { decision: 'approved' }, firstKey).expect(200);
      await reached(take.arrived, 'the run taking the first decision', 15_000);
      const onItsWay = await answer('stale', 'approval', { decision: 'rejected' }, firstKey);
      expect(onItsWay.status).toBe(409);
      expect(onItsWay.body.detail).toBe(`Step "${firstKey}" of run stale is already decided`);
      expect((await inboxFor('stale')).map((r) => r.step_key)).toEqual([secondKey]);
    } finally {
      take.restore();
    }

    await eventually(
      async () =>
        (await http().get('/api/runs/stale').expect(200)).body.steps as Array<Record<string, unknown>>,
      (steps) => steps.find((s) => s.step_key === firstKey)?.status === 'completed',
      'the run took the first decision',
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
  }, 60_000);

  /** The run row's id, slot and each step's receive, by step key. */
  async function receivesOf(
    runId: string,
  ): Promise<{ slot: string | null; delivery: Record<string, string | null> }> {
    const run = await db.query<{ id: string; waiting_node_id: string | null }>(
      `SELECT id, waiting_node_id FROM runtime_runs WHERE run_id = $1`,
      [runId],
    );
    const steps = await db.query<{ step_key: string; delivery_topic: string | null }>(
      `SELECT step_key, delivery_topic FROM runtime_run_steps WHERE run_id = $1 AND waiting_topic IS NOT NULL`,
      [run.rows[0]?.id],
    );
    return {
      slot: run.rows[0]?.waiting_node_id ?? null,
      delivery: Object.fromEntries(steps.rows.map((s) => [s.step_key, s.delivery_topic])),
    };
  }

  it('receives approvals one after another on one topic on the topic itself in process, mirrored for an earlier version, and each on its own step’s topic on the sequenced engine', async () => {
    const parked = (stepKey: string) =>
      rail.dbos
        ? { slot: null, delivery: { [stepKey]: eventTopicFor(stepKey) } }
        : { slot: stepKey, delivery: { [stepKey]: null } };
    const waits: Wait[] = [
      { id: 'manager', topic: 'approval' },
      { id: 'director', topic: 'approval' },
    ];
    const seq = rail.startShape(http, 'seq', 'sequence', waits);
    await eventually(
      () => receivesOf('seq'),
      (r) => 'manager' in r.delivery,
      'the manager parked',
    );
    expect(await receivesOf('seq')).toEqual(parked('manager'));

    await answer('seq', 'approval', { by: 'manager' }).expect(200);
    await eventually(
      () => receivesOf('seq'),
      (r) => 'director' in r.delivery,
      'the director parked',
    );
    expect(await receivesOf('seq')).toEqual(parked('director'));

    await answer('seq', 'approval', { by: 'director' }).expect(200);
    const done = await seq;
    expect(done.body.outputs).toMatchObject({ manager: { by: 'manager' }, director: { by: 'director' } });
  });

  it('takes the step_key the inbox lists for a wait inside a loop, and names the wait for a key the run never had', async () => {
    const looped = rail.startShape(http, 'looped', 'loop', [{ id: 'review', topic: 'review' }]);
    const [row] = await eventually(
      () => inboxFor('looped'),
      (rows) => rows.length === 1,
      'the loop’s wait listed',
    );
    expect(row).toMatchObject({ step_key: 'lp#0/review', node_id: 'review' });

    const byNode = await answer('looped', 'review', { d: 'no' }, 'review');
    expect(byNode.status).toBe(409);
    expect(byNode.body.detail).toBe('Run looped has no wait at step "review" — it waits at "lp#0/review"');

    await answer('looped', 'review', { d: 'yes' }, row!.step_key as string).expect(200);
    const done = await looped;
    expect(done.status).toBe(201);
  });

  it('credits whoever decides whatever the payload, and a decision without one binds null', async () => {
    for (const [runId, body] of [
      ['given-null', { topic: 'approval', payload: null }],
      ['given-none', { topic: 'approval' }],
    ] as const) {
      const run = rail.start(http, runId, [{ id: 'approve', topic: 'approval' }]);
      await eventually(
        () => inboxFor(runId),
        (rows) => rows.length === 1,
        `${runId} listed`,
      );
      await http().post(`/api/runs/${runId}/events`).send(body).expect(200);
      expect((await run).body.outputs).toEqual({ approve: null });
      const detail = await http().get(`/api/runs/${runId}`).expect(200);
      expect(detail.body.decided_by).toMatchObject({ id: MOCK_USER_ID });
    }
  });

  it('reads a decision on its way to the run as decided, by whom, and leaves it out of the inbox', async () => {
    const run = rail.start(http, 'on-its-way', [{ id: 'approve', topic: 'approval', windowMs: 15_000 }]);
    await eventually(
      () => inboxFor('on-its-way'),
      (rows) => rows.length === 1,
      'the approval listed',
    );
    const stepKey = rail.stepKey([{ id: 'approve', topic: 'approval' }], 'approve');
    await db.query(
      `UPDATE runtime_run_steps s SET claimed_at = now(), claimed_by = $2, claimed_payload = '{"d":1}'
         FROM runtime_runs r WHERE r.id = s.run_id AND r.run_id = $1 AND s.step_key = $3`,
      ['on-its-way', MOCK_USER_ID, stepKey],
    );

    const detail = await http().get('/api/runs/on-its-way').expect(200);
    const decided = {
      kind: 'decided',
      until: await deadlineOf('on-its-way', stepKey),
      decided_by: { id: MOCK_USER_ID, name: expect.anything(), email: expect.anything() },
    };
    expect(detail.body.waiting).toEqual(decided);
    expect((detail.body.steps as Array<{ waiting: unknown }>)[0]!.waiting).toEqual(decided);
    expect(await inboxFor('on-its-way')).toEqual([]);
    expect((await run).body.outputs).toEqual({ approve: null });
  }, 60_000);

  it('says a wait still parked past its deadline timed out, not that it is about to', async () => {
    const run = rail.start(http, 'overdue', [{ id: 'approve', topic: 'approval', windowMs: 15_000 }]);
    await eventually(
      () => inboxFor('overdue'),
      (rows) => rows.length === 1,
      'the approval listed',
    );
    await db.query(
      `UPDATE runtime_run_steps s SET waiting_timeout_at = now() - interval '5 minutes'
         FROM runtime_runs r WHERE r.id = s.run_id AND r.run_id = 'overdue'`,
    );
    expect(await inboxFor('overdue')).toEqual([]);
    const refused = await answer('overdue', 'approval', { d: 'late' });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toBe(
      'Run overdue is no longer waiting on topic "approval" — the wait timed out',
    );
    expect((await run).body.outputs).toEqual({ approve: null });
  }, 60_000);

  it('refuses a wait topic spelled like a step’s own receive before any step runs', async () => {
    const refused = await rail.start(http, 'squatter', [{ id: 'a', topic: 'orchestr:wait:fork|0/b' }]);
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain('topics starting "orchestr:wait:" are reserved');
  });

  it(
    'never wakes a Wait step before the time its history says it sleeps until, which is the deadline it parked on, even when its start or park is written late or its park not at all',
    async () => {
      const asks = new Map<string, { arrived: Deferred; answer: Deferred }>();
      const fixture = createServer((req, res) => {
        const ask = asks.get(req.url ?? '');
        ask?.arrived.resolve();
        void ask?.answer.promise.then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

      // The step's start is held by its foreign-key check, which a FOR UPDATE blocks; its park by the run's row lock, which a FOR SHARE blocks.
      const HOLDS = {
        start: { lock: 'FOR UPDATE', blocked: /^\s*INSERT INTO runtime_run_steps/ },
        park: { lock: 'FOR SHARE', blocked: /FROM runtime_runs WHERE id = \$1 FOR NO KEY UPDATE/ },
      };

      // One of the step's history writes waits on a lock a second connection holds on its run row, and is then let through or cancelled.
      const held = async (
        runId: string,
        write: keyof typeof HOLDS,
        lost = false,
      ): Promise<{ run: Promise<Response>; parkedUntil: number | null }> => {
        const ask = { arrived: deferred(), answer: deferred() };
        asks.set(`/${runId}`, ask);
        const run = http()
          .post('/api/runs')
          .send({
            run_id: runId,
            plan: {
              id: `plan-${runId}`,
              nodes: [
                {
                  kind: 'action',
                  id: 'ask',
                  actionId: 'http.send_request',
                  props: { method: 'GET', url: `${base}/${runId}` },
                },
                { kind: 'delay', id: 'pause', ms: PARK_DELAY_ABOVE_MS + 1_000 },
              ],
            },
          })
          .then((res) => res);
        await reached(ask.arrived.promise, `${runId}'s step before its wait`, 15_000);
        const holder = new Client({ connectionString: process.env.DATABASE_URL });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          const { rows: locked } = await holder.query<{ holder: number }>(
            `SELECT pg_backend_pid() AS holder FROM runtime_runs WHERE run_id = $1 ${HOLDS[write].lock}`,
            [runId],
          );
          ask.answer.resolve();
          // Read outside the holder's transaction, which would keep one snapshot of pg_stat_activity throughout.
          const [blocked] = await eventually(
            async () =>
              (
                await db.query<{ pid: number; query: string }>(
                  `SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
                  [locked[0]!.holder],
                )
              ).rows,
            (rows) => rows.length === 1,
            `${runId}'s ${write} held on its row`,
          );
          expect(blocked!.query).toMatch(HOLDS[write].blocked);
          await pause(PARK_HELD_MS);
          if (lost) await holder.query(`SELECT pg_cancel_backend($1)`, [blocked!.pid]);
          await holder.query('COMMIT');
        } finally {
          await holder.end();
        }
        if (lost) return { run, parkedUntil: null };
        const [parked] = await eventually(
          async () =>
            (
              await db.query<{ until: Date }>(
                `SELECT s.waiting_timeout_at AS until FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
                  WHERE r.run_id = $1 AND s.step_key = 'pause' AND s.waiting_timeout_at IS NOT NULL`,
                [runId],
              )
            ).rows,
          (rows) => rows.length === 1,
          `${runId}'s park written`,
        );
        return { run, parkedUntil: parked!.until.getTime() };
      };

      const sleptAndWoke = async (runId: string): Promise<{ due: number; woke: number }> => {
        const detail = await http().get(`/api/runs/${runId}`).expect(200);
        const paused = (detail.body.steps as Array<Record<string, unknown>>).find(
          (s) => s.step_key === 'pause',
        );
        expect(paused).toMatchObject({ kind: 'delay', status: 'completed' });
        return {
          due: Date.parse((paused!.output as { slept_until: string }).slept_until),
          woke: Date.parse(paused!.finished_at as string),
        };
      };

      try {
        const startLate = await held('start-late', 'start');
        const parkLate = await held('park-late', 'park');
        const parkLost = await held('park-lost', 'park', true);
        for (const { run } of [startLate, parkLate, parkLost]) expect((await run).status).toBe(201);

        const startedLate = await sleptAndWoke('start-late');
        const writtenLate = await sleptAndWoke('park-late');
        const neverWritten = await sleptAndWoke('park-lost');
        expect(startedLate.due).toBe(startLate.parkedUntil);
        expect(writtenLate.due).toBe(parkLate.parkedUntil);
        for (const { due, woke } of [startedLate, writtenLate, neverWritten]) {
          expect(woke).toBeGreaterThanOrEqual(due);
        }
      } finally {
        await new Promise<void>((resolve) => fixture.close(() => resolve()));
      }
    },
    PARK_DELAY_ABOVE_MS + 90_000,
  );

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
