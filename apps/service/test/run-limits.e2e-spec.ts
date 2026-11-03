import request from 'supertest';

import { DbosRuntime } from '../src/dbos/dbos-runtime';
import { AGENT_MODEL_CALL } from '../src/runtime/agent';
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
} from './support/limits-fixture';

const MAX_STEPS = 8;
const MAX_LOOP_ROUNDS = 6;
const STEPS_TAKEN = `Run limit reached: this run took ${MAX_STEPS} steps, the most one run may take in this workspace — the steps of workflows it calls count too. An operator can raise RUN_MAX_STEPS.`;
const CALLER_TOOK = `Run limit reached: the top-level run this one was called under took ${MAX_STEPS} steps, the most one run may take in this workspace — counting every workflow it calls, this one included. An operator can raise RUN_MAX_STEPS.`;

const steps = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** A run's steps and loop rounds, on the real engine with DBOS on, against the limits its operator set (in process, mock auth). */
describe('run limits: steps and loop rounds (e2e, DBOS on)', () => {
  const fixture = new HitFixture();
  // Asked for a turn, it calls the first tool it is offered, as a model that never stops calling one does.
  const model = {
    callCount: 0,
    call(req: { tools: Array<{ name: string }> }) {
      this.callCount += 1;
      return Promise.resolve({
        text: 'again',
        toolCalls: [{ id: `c${this.callCount}`, name: req.tools[0]!.name, input: {} }],
      });
    },
  };
  let limits: LimitsApp;
  const http = () => request(limits.app.getHttpServer());

  const run = (runId: string, nodes: unknown[], edges: unknown[], trigger?: unknown) =>
    http()
      .post('/api/runs/from-ir')
      .send({
        run_id: runId,
        workflow_ir: ir(nodes, edges),
        ...(trigger ? { trigger_payload: trigger } : {}),
      });

  const calls = (base: string, ids: string[]) => ids.map((id) => callStep(base, id));

  beforeAll(async () => {
    await fixture.listen();
    limits = await bootLimitsApp(
      {
        RUN_MAX_STEPS: String(MAX_STEPS),
        RUN_MAX_LOOP_ROUNDS: String(MAX_LOOP_ROUNDS),
        RUN_MAX_ACTIVE_SECONDS: '0',
      },
      (builder) => builder.overrideProvider(AGENT_MODEL_CALL).useValue(model),
    );
  }, 60_000);

  afterAll(async () => {
    await limits.close();
    await fixture.close();
  }, 60_000);

  beforeEach(() => fixture.reset());

  it('a run past its step limit makes exactly that many calls, ends at the step that crossed it, which fires nothing, reads Run limit reached naming RUN_MAX_STEPS, and its caller is answered 422 run_limit_reached', async () => {
    const ids = steps('s', MAX_STEPS + 2);
    const res = await run('steps-past', calls(fixture.base, ids), chain(ids));

    expect(ids.map((id) => fixture.count(`/${id}`))).toEqual(ids.map((_, i) => (i < MAX_STEPS ? 1 : 0)));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.steps',
      max: MAX_STEPS,
      failed_node_id: `s${MAX_STEPS + 1}`,
    });
    expect(res.body.detail).toBe(STEPS_TAKEN);
    const row = await runRow(limits.db, 'steps-past');
    expect(row).toMatchObject({ status: 'error', error: res.body.detail, steps_used: MAX_STEPS });
    expect(row.limits).toEqual({
      'run.steps': MAX_STEPS,
      'run.loop_rounds': MAX_LOOP_ROUNDS,
      'run.active_seconds': null,
    });
    const crossed = await limits.db.query<{ status: string; error: string }>(
      `SELECT status, error FROM runtime_run_steps WHERE run_id = $1 AND node_id = $2`,
      [row.id, `s${MAX_STEPS + 1}`],
    );
    expect(crossed.rows).toEqual([{ status: 'error', error: res.body.detail }]);
  }, 60_000);

  it('a run within its step limit runs every step', async () => {
    const ids = steps('w', MAX_STEPS);
    const res = await run('steps-within', calls(fixture.base, ids), chain(ids));

    expect(res.status).toBe(201);
    expect(ids.map((id) => fixture.count(`/${id}`))).toEqual(ids.map(() => 1));
    expect(await runRow(limits.db, 'steps-within')).toMatchObject({
      status: 'completed',
      steps_used: MAX_STEPS,
    });
  }, 60_000);

  it.each([
    ['an error lane', { lane: true }],
    ['continue-on-fail', { lane: false }],
  ])(
    'neither %s nor anything after it absorbs a step-limit refusal',
    async (_, { lane }) => {
      const ids = steps(lane ? 'l' : 'c', MAX_STEPS);
      const refused = irNode(lane ? 'lrefused' : 'crefused', 'http.send_request', {
        method: 'GET',
        url: `${fixture.base}/refused`,
        ...(lane ? {} : { onError: 'continue' }),
      });
      const after = callStep(fixture.base, lane ? 'lane' : 'after');
      const nodes = [...calls(fixture.base, ids), refused, after];
      const edges = [
        ...chain([...ids, refused.id]),
        lane ? edgeOn(refused.id, after.id, 0, 'error') : edgeOn(refused.id, after.id),
      ];
      const res = await run(lane ? 'lane-absorbs' : 'continue-absorbs', nodes, edges);

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'run_limit_reached', limit: 'run.steps' });
      expect({ refused: fixture.count('/refused'), after: fixture.count(`/${after.id}`) }).toEqual({
        refused: 0,
        after: 0,
      });
      // Neither went on from the refusal: the refused step is not marked tolerated, and nothing after it was started.
      const rows = await limits.db.query<{ node_id: string; continued: boolean }>(
        `SELECT node_id, continued FROM runtime_run_steps WHERE run_id = $1 AND node_id IN ($2, $3)`,
        [(await runRow(limits.db, lane ? 'lane-absorbs' : 'continue-absorbs')).id, refused.id, after.id],
      );
      expect(rows.rows).toEqual([{ node_id: refused.id, continued: false }]);
    },
    60_000,
  );

  it("a called workflow's steps count against the run that called it, and its refusal ends the caller through the call's error lane too, each run's history saying whose steps reached the limit", async () => {
    const child = steps('k', 3);
    const deployed = await http()
      .post('/api/deploy')
      .send({
        workflow_json: ir(
          [
            irNode('trigger', 'orchestr:tool_trigger', {
              tool_name: 'three_calls',
              description: 'makes three calls',
              inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
            }),
            ...calls(fixture.base, child),
          ],
          [edgeOn('trigger', child[0]!), ...chain(child)],
        ),
      })
      .expect(201);
    const parent = steps('p', MAX_STEPS - 3);
    const res = await run(
      'called-counts',
      [
        ...calls(fixture.base, parent),
        irNode('call', 'orchestr:call_workflow', { workflow_id: deployed.body.workflow_id }),
        callStep(fixture.base, 'calllane'),
        callStep(fixture.base, 'after'),
      ],
      [...chain([...parent, 'call', 'after']), edgeOn('call', 'calllane', 0, 'error')],
    );

    // The caller's own steps, its call, and the called run's first two make the eight; the third is refused.
    expect(child.map((id) => fixture.count(`/${id}`))).toEqual([1, 1, 0]);
    expect({ lane: fixture.count('/calllane'), after: fixture.count('/after') }).toEqual({
      lane: 0,
      after: 0,
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.steps',
      max: MAX_STEPS,
      detail: STEPS_TAKEN,
    });
    const called = await limits.db.query<{ id: string; status: string; error: string; steps_used: number }>(
      `SELECT id, status, error, steps_used FROM runtime_runs WHERE parent_run_id = (SELECT id FROM runtime_runs WHERE run_id = 'called-counts')`,
    );
    expect(called.rows).toEqual([
      { id: expect.any(String), status: 'error', error: CALLER_TOOK, steps_used: 0 },
    ]);
    const stepErrors = await limits.db.query<{ node_id: string; error: string }>(
      `SELECT node_id, error FROM runtime_run_steps WHERE (run_id = $1 AND node_id = 'k3') OR (run_id = $2 AND node_id = 'call') ORDER BY node_id`,
      [called.rows[0]!.id, (await runRow(limits.db, 'called-counts')).id],
    );
    expect(stepErrors.rows).toEqual([
      { node_id: 'call', error: STEPS_TAKEN },
      { node_id: 'k3', error: CALLER_TOOK },
    ]);
    expect(await runRow(limits.db, 'called-counts')).toMatchObject({
      status: 'error',
      error: STEPS_TAKEN,
      steps_used: MAX_STEPS,
    });
  }, 60_000);

  it("an AI Agent's model and tool calls each take a step, so an agent that calls a tool every turn ends at the limit", async () => {
    model.callCount = 0;
    const res = await run(
      'agent-counts',
      [
        irNode('agent', 'orchestr:agent', {
          model: { provider: 'claude', model: 'claude-opus-4-8' },
          system_prompt: 'Look it up.',
          max_steps: 20,
          input: 'go',
        }),
        irNode('lookup', 'http.send_request', { method: 'GET', url: `${fixture.base}/lookup` }),
      ],
      [edgeOn('agent', 'lookup', 0, 'tool')],
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.steps',
      failed_node_id: 'agent',
    });
    // Model, tool, model, tool … : the eight steps are four of each, and the fifth model call is refused.
    expect({ model: model.callCount, tool: fixture.count('/lookup') }).toEqual({
      model: MAX_STEPS / 2,
      tool: MAX_STEPS / 2,
    });
  }, 60_000);

  it('an AI Agent tested on its own, which keeps no history, counts its steps in memory and stops at the limit', async () => {
    model.callCount = 0;
    const res = await http()
      .post('/api/runs/test-agent')
      .send({
        node_id: 'agent',
        input: 'go',
        workflow_ir: ir(
          [
            irNode('agent', 'orchestr:agent', {
              model: { provider: 'claude', model: 'claude-opus-4-8' },
              system_prompt: 'Look it up.',
              max_steps: 20,
            }),
            irNode('lookup', 'http.send_request', { method: 'GET', url: `${fixture.base}/tested` }),
          ],
          [edgeOn('agent', 'lookup', 0, 'tool')],
        ),
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'run_limit_reached', limit: 'run.steps', max: MAX_STEPS });
    expect({ model: model.callCount, tool: fixture.count('/tested') }).toEqual({
      model: MAX_STEPS / 2,
      tool: MAX_STEPS / 2,
    });
  }, 60_000);

  it('two branches running side by side charge one count: 2×5 calls under a limit of 8 make 8', async () => {
    const left = steps('a', 5);
    const right = steps('b', 5);
    const res = await run(
      'side-by-side',
      [...calls(fixture.base, left), ...calls(fixture.base, right)],
      [...chain(left), ...chain(right)],
    );

    expect(res.status).toBe(422);
    expect(fixture.countUnder('/a') + fixture.countUnder('/b')).toBe(MAX_STEPS);
    expect(await runRow(limits.db, 'side-by-side')).toMatchObject({ status: 'error', steps_used: MAX_STEPS });
  }, 60_000);

  const forEach = (runId: string, items: number) =>
    run(
      runId,
      [
        irNode('each', 'orchestr:loop', { items: '{{trigger.list}}' }),
        callStep(fixture.base, 'visit'),
        callStep(fixture.base, 'done'),
      ],
      [edgeOn('each', 'visit', 0), edgeOn('each', 'done', 1)],
      { list: Array.from({ length: items }, (_, i) => i) },
    );

  it('a forEach given more items than the run has loop rounds left ends before its first item', async () => {
    const res = await forEach('each-over', MAX_LOOP_ROUNDS + 1);

    expect({ items: fixture.count('/visit'), done: fixture.count('/done') }).toEqual({ items: 0, done: 0 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.loop_rounds',
      max: MAX_LOOP_ROUNDS,
    });
    expect(res.body.detail).toBe(
      `Run limit reached: loop "each" was given ${MAX_LOOP_ROUNDS + 1} items, more than the ${MAX_LOOP_ROUNDS} loop rounds this run has left of the ${MAX_LOOP_ROUNDS} one run may take in this workspace. Split the list, or an operator can raise RUN_MAX_LOOP_ROUNDS.`,
    );
    expect(await runRow(limits.db, 'each-over')).toMatchObject({ status: 'error', error: res.body.detail });
  }, 60_000);

  it('a forEach given exactly the loop rounds the run has left runs every item', async () => {
    const res = await forEach('each-exact', MAX_LOOP_ROUNDS);

    expect(res.status).toBe(201);
    expect({ items: fixture.count('/visit'), done: fixture.count('/done') }).toEqual({
      items: MAX_LOOP_ROUNDS,
      done: 1,
    });
  }, 60_000);

  const whileLoop = (id: string, again: boolean) =>
    irNode(id, 'orchestr:loop', {
      mode: 'while',
      condition: { left: 'go', op: 'eq', right: again ? 'go' : 'stop' },
      max_iterations: 1_000,
    });

  it("a while loop still going at its run's loop rounds ends the run; one its condition ends first is untouched", async () => {
    const res = await run(
      'while-over',
      [whileLoop('spin', true), callStep(fixture.base, 'round'), callStep(fixture.base, 'after')],
      [edgeOn('spin', 'round', 0), edgeOn('spin', 'after', 1)],
    );

    expect({ rounds: fixture.count('/round'), after: fixture.count('/after') }).toEqual({
      rounds: MAX_LOOP_ROUNDS,
      after: 0,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toBe(
      `Run limit reached: while loop "spin" needed another round after this run had taken its ${MAX_LOOP_ROUNDS} loop rounds, the most one run may take in this workspace. Lower its max_iterations, or an operator can raise RUN_MAX_LOOP_ROUNDS.`,
    );

    fixture.reset();
    const ended = await run(
      'while-within',
      [whileLoop('once', false), callStep(fixture.base, 'round'), callStep(fixture.base, 'after')],
      [edgeOn('once', 'round', 0), edgeOn('once', 'after', 1)],
    );
    expect(ended.status).toBe(201);
    expect({ rounds: fixture.count('/round'), after: fixture.count('/after') }).toEqual({
      rounds: 1,
      after: 1,
    });
  }, 60_000);

  it("nested while loops whose body takes no step end at the run's loop rounds, counted over both loops", async () => {
    const res = await run(
      'nested-opless',
      [
        whileLoop('outer', true),
        whileLoop('inner', true),
        // A condition that can't resolve is recorded as a step row each round, which counts the rounds the body ran.
        irNode('check', 'orchestr:if', { left: '{{trigger.missing}}', op: 'ne', right: 'x' }),
      ],
      [edgeOn('outer', 'inner', 0), edgeOn('inner', 'check', 0)],
      {},
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'run_limit_reached', limit: 'run.loop_rounds' });
    const rounds = await limits.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_run_steps WHERE run_id = (SELECT id FROM runtime_runs WHERE run_id = 'nested-opless') AND node_id = 'check'`,
    );
    // The outer loop's first round takes one, so the inner loop runs five before the sixth round is refused.
    expect(rounds.rows[0]!.n).toBe(MAX_LOOP_ROUNDS - 1);
  }, 60_000);

  it('a resend of a run a step limit ended, whose workflow a crash left ending on the history gate, is answered with the step limit, never the time limit', async () => {
    const scoped = `${MOCK_USER_ID}:recorded-steps`;
    // What a crash after the run's row read the limit, and before DBOS recorded the end, leaves behind.
    await limits.db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, error, started_at, finished_at, limits, steps_used)
       VALUES ($1, 'recorded-steps', $2, 'p', 'error', $3, now(), now(), $4, $5)`,
      [
        scoped,
        MOCK_USER_ID,
        STEPS_TAKEN,
        JSON.stringify({
          'run.steps': MAX_STEPS,
          'run.loop_rounds': MAX_LOOP_ROUNDS,
          'run.active_seconds': 7,
        }),
        MAX_STEPS,
      ],
    );
    await limits.db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at, error)
       VALUES (gen_random_uuid(), $1, 'r9', 'r9', 'action', 'error', now(), now(), $2)`,
      [scoped, STEPS_TAKEN],
    );
    const recovered = await limits.app
      .get(DbosRuntime)
      .startDurably({ id: 'p', nodes: [] }, { externalUserId: MOCK_USER_ID, runId: scoped });
    await expect(recovered.result()).rejects.toThrow('Run already ended');

    const res = await run('recorded-steps', calls(fixture.base, ['never']), []);

    expect(fixture.count('/never')).toBe(0);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'run_limit_reached',
      limit: 'run.steps',
      max: MAX_STEPS,
      detail: STEPS_TAKEN,
    });
  }, 60_000);
});
