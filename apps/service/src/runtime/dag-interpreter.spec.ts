import { PassThroughDurableStep, type DurableStep } from '../providers/durable-step';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import { DagInterpreter } from './dag-interpreter';
import type { DagActionNode, DagNode, DagPlan, Guard } from './dag-plan';

/**
 * The gating scheduler's OWN semantics, on hand-built DagPlans: run/skip gating, IF port routing,
 * fan-in OR-join, nested-scope forEach/parallel, and error lanes. `forEach`/`parallel` have no IR
 * source, so they can only be proven here.
 */

/** Deterministic echo provider: every action returns `{ ran, props }`; `fail` throws. */
function echoProvider(fail: (actionId: string) => boolean = () => false): ManagedIntegrationProvider {
  return {
    key: 'echo',
    runAction: (input) =>
      fail(input.actionId)
        ? Promise.reject(new Error(`boom:${input.actionId}`))
        : Promise.resolve({ output: { ran: input.actionId, props: input.props } }),
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}

const guard = (source: string, port = 0): Guard => ({ source, port });

function action(
  id: string,
  props: Record<string, unknown> = {},
  guards: Guard[] = [],
  extra: Partial<DagActionNode> = {},
): DagNode {
  return { kind: 'action', id, actionId: `act.${id}`, props, guards, ...extra };
}

const plan = (nodes: DagNode[]): DagPlan => ({ id: 'dag', nodes });

describe('DagInterpreter (gating scheduler)', () => {
  const interpreter = new DagInterpreter(echoProvider());

  it('runs a linear chain and passes an upstream output into a downstream step', async () => {
    const result = await interpreter.run(
      plan([action('a'), action('b', { up: '{{a.ran}}' }, [guard('a')])]),
      { externalUserId: 'u' },
    );
    expect(result.outputs.a).toEqual({ ran: 'act.a', props: {} });
    expect(result.outputs.b).toEqual({ ran: 'act.b', props: { up: 'act.a' } });
    // Execution order is the plan's topo order (observability trace).
    expect(result.trace.map((t) => t.nodeId)).toEqual(['a', 'b']);
  });

  it('IF: runs the live port, SKIPS the dead port (writes nothing)', async () => {
    const built = (flag: boolean): DagPlan =>
      plan([
        { kind: 'if', id: 'check', condition: { left: flag, op: 'truthy' }, guards: [] },
        action('yes', {}, [guard('check', 0)]),
        action('no', {}, [guard('check', 1)]),
      ]);
    const truthy = await interpreter.run(built(true), { externalUserId: 'u' });
    expect(truthy.outputs.yes).toEqual({ ran: 'act.yes', props: {} });
    expect(truthy.outputs.no).toBeUndefined(); // dead branch — never recorded
    expect(truthy.outputs.check).toBeUndefined(); // an IF produces no scope output

    const falsy = await interpreter.run(built(false), { externalUserId: 'u' });
    expect(falsy.outputs.no).toEqual({ ran: 'act.no', props: {} });
    expect(falsy.outputs.yes).toBeUndefined();
  });

  it('skip propagates: a node guarded only by a skipped node is itself skipped', async () => {
    const result = await interpreter.run(
      plan([
        { kind: 'if', id: 'check', condition: { left: false, op: 'truthy' }, guards: [] },
        action('dead', {}, [guard('check', 0)]), // else port — skipped
        action('deadChild', {}, [guard('dead')]), // only inflow is the skipped node
        action('alive', {}, [guard('check', 1)]), // else port — runs
      ]),
      { externalUserId: 'u' },
    );
    expect(result.outputs.dead).toBeUndefined();
    expect(result.outputs.deadChild).toBeUndefined(); // skip cascades through the dead node
    expect(result.outputs.alive).toEqual({ ran: 'act.alive', props: {} });
  });

  it('fan-in OR-join: a node with N guards runs ONCE when ANY live path reaches it', async () => {
    // split → m1, split → m2, m1 → join, m2 → join (diamond) — join has 2 guards.
    const result = await interpreter.run(
      plan([
        action('split'),
        action('m1', {}, [guard('split')]),
        action('m2', {}, [guard('split')]),
        action('join', {}, [guard('m1'), guard('m2')]),
      ]),
      { externalUserId: 'u' },
    );
    expect(result.trace.filter((t) => t.nodeId === 'join')).toHaveLength(1); // ONCE
    expect(result.outputs.join).toEqual({ ran: 'act.join', props: {} });
  });

  it('forEach: runs the nested body per element in a child scope; output is the per-iteration array', async () => {
    const body: DagPlan = { id: 'dag#each', nodes: [action('call', { v: '{{letter}}' }, [])] };
    const result = await interpreter.run(
      plan([
        action('seed', { items: ['a', 'b', 'c'] }),
        {
          kind: 'forEach',
          id: 'each',
          items: '{{seed.props.items}}',
          itemVar: 'letter',
          body,
          guards: [guard('seed')],
        },
      ]),
      { externalUserId: 'u' },
    );
    const iterations = result.outputs.each as Array<{ call: { props: { v: string } } }>;
    expect(iterations).toHaveLength(3);
    expect(iterations.map((it) => it.call.props.v)).toEqual(['a', 'b', 'c']);
    // Path-scoped durable/trace keys keep iterations distinct.
    expect(result.trace.map((t) => t.nodeId)).toEqual(['seed', 'each#0/call', 'each#1/call', 'each#2/call']);
  });

  it('parallel: runs each nested branch in its own scope, merging new outputs back', async () => {
    const left: DagPlan = { id: 'dag#l', nodes: [action('left', { side: 'L' })] };
    const right: DagPlan = { id: 'dag#r', nodes: [action('right', { side: 'R' })] };
    const result = await interpreter.run(
      plan([{ kind: 'parallel', id: 'fork', branches: [left, right], guards: [] }]),
      { externalUserId: 'u' },
    );
    expect(result.outputs.left).toEqual({ ran: 'act.left', props: { side: 'L' } });
    expect(result.outputs.right).toEqual({ ran: 'act.right', props: { side: 'R' } });
  });

  it('delay: pauses via the DurableStep with a plan-scoped, path-scoped key', async () => {
    const sleeps: Array<{ name: string; ms: number }> = [];
    const recording: DurableStep = {
      run: (_n, fn) => fn(),
      sleep: (name, ms) => {
        sleeps.push({ name, ms });
        return Promise.resolve();
      },
      waitForEvent: () => Promise.resolve(null),
    };
    await interpreter.run(
      plan([
        action('before'),
        { kind: 'delay', id: 'wait', ms: 40, guards: [guard('before')] },
        action('after', {}, [guard('wait')]),
      ]),
      { externalUserId: 'u', durable: recording },
    );
    expect(sleeps).toEqual([{ name: 'dag:wait', ms: 40 }]);
  });

  it('waitForEvent: suspends until an event is delivered, then binds the payload', async () => {
    const durable = new PassThroughDurableStep();
    const runPromise = interpreter.run(
      plan([
        { kind: 'waitForEvent', id: 'approval', topic: 'approve', timeoutMs: 2000, guards: [] },
        action('act', { decision: '{{approval.decision}}' }, [guard('approval')]),
      ]),
      { externalUserId: 'u', durable },
    );
    for (let i = 0; i < 50 && !durable.deliver('approve', { decision: 'ok' }); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await runPromise;
    expect(result.outputs.approval).toEqual({ decision: 'ok' });
    expect(result.outputs.act).toEqual({ ran: 'act.act', props: { decision: 'ok' } });
  });

  it('pinning: a pinned action replays its output and never calls the provider', async () => {
    const seen: string[] = [];
    const recording: DurableStep = {
      run: <T>(name: string, fn: () => Promise<T>) => {
        seen.push(name);
        return fn();
      },
      sleep: () => Promise.resolve(),
      waitForEvent: () => Promise.resolve(null),
    };
    const result = await interpreter.run(
      plan([action('fetch'), action('push', { up: '{{fetch.id}}' }, [guard('fetch')])]),
      { externalUserId: 'u', durable: recording, pins: { fetch: { id: 99 } } },
    );
    expect(result.outputs.fetch).toEqual({ id: 99 }); // replayed verbatim
    expect(result.outputs.push).toEqual({ ran: 'act.push', props: { up: 99 } });
    expect(seen).toEqual(['dag:push']); // only push went through the durable provider step
  });

  it('error lane: a throwing action runs its nested lane, skips the main successor, completes', async () => {
    const failing = new DagInterpreter(echoProvider((id) => id === 'act.boom'));
    const lane: DagPlan = {
      id: 'dag#boom:error',
      nodes: [action('handler', { msg: '{{boom.error.message}}' }, [])],
    };
    const result = await failing.run(
      plan([action('boom', {}, [], { onErrorBranch: lane }), action('after', {}, [guard('boom')])]),
      { externalUserId: 'u' },
    );
    expect((result.outputs.handler as { props: { msg: string } }).props.msg).toContain('boom:act.boom');
    expect(result.outputs.after).toBeUndefined(); // main successor skipped — never both lanes
    expect((result.outputs.boom as { __errored: boolean }).__errored).toBe(true);
  });

  it('continue-on-fail: a tolerated throw captures the error and lets the run go on', async () => {
    const failing = new DagInterpreter(echoProvider((id) => id === 'act.boom'));
    const result = await failing.run(
      plan([
        action('boom', {}, [], { onError: 'continue' }),
        action('after', { msg: '{{boom.error.message}}' }, [guard('boom')]),
      ]),
      { externalUserId: 'u' },
    );
    expect((result.outputs.boom as { __errored: boolean }).__errored).toBe(true);
    expect((result.outputs.after as { props: { msg: string } }).props.msg).toContain('boom:act.boom');
  });

  it('retry-on-fail: the provider is retried up to maxAttempts inside the one step', async () => {
    let calls = 0;
    const flaky: ManagedIntegrationProvider = {
      key: 'flaky',
      runAction: () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new Error(`transient ${calls}`))
          : Promise.resolve({ output: { onCall: calls } });
      },
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    };
    const result = await new DagInterpreter(flaky).run(
      plan([action('a', {}, [], { retry: { maxAttempts: 3, backoffMs: 0 } })]),
      { externalUserId: 'u' },
    );
    expect(calls).toBe(3);
    expect(result.outputs.a).toEqual({ onCall: 3 });
  });

  it('rejects a plan with duplicate node ids', async () => {
    await expect(interpreter.run(plan([action('a'), action('a')]), { externalUserId: 'u' })).rejects.toThrow(
      /Duplicate node id "a"/,
    );
  });
});

/**
 * A branch decided on a reference that resolved to nothing used to leave no trace at all: `if` and
 * `switch` are pure routing and get no step, so the run took a path for a reason nobody could see.
 */
describe('a branch that could not resolve its condition says so', () => {
  const interpreter = new DagInterpreter(echoProvider());

  it('records the routing decision and names the reference behind it', async () => {
    const result = await interpreter.run(
      plan([
        action('a'),
        {
          kind: 'if',
          id: 'check',
          condition: { left: '{{a.missingField}}', op: 'eq', right: 'x' },
          guards: [guard('a')],
        },
        action('yes', {}, [guard('check', 0)]),
        action('no', {}, [guard('check', 1)]),
      ]),
      { externalUserId: 'u' },
    );

    const routing = result.trace.find((entry) => entry.nodeId === 'check');
    expect(routing?.warnings).toEqual(['Reference {{a.missingField}} resolved to nothing.']);
    // The decision itself is still made and still routes — this is a note, not a failure.
    expect(routing?.output).toEqual({ selected_port: 1 });
    expect(result.outputs.no).toEqual({ ran: 'act.no', props: {} });
  });

  it('stays quiet for `falsy`, where a missing value IS the question being asked', async () => {
    const result = await interpreter.run(
      plan([
        action('a'),
        {
          kind: 'if',
          id: 'check',
          condition: { left: '{{a.missingField}}', op: 'falsy' },
          guards: [guard('a')],
        },
        action('yes', {}, [guard('check', 0)]),
      ]),
      { externalUserId: 'u' },
    );
    expect(result.trace.find((entry) => entry.nodeId === 'check')).toBeUndefined();
    expect(result.outputs.yes).toEqual({ ran: 'act.yes', props: {} });
  });

  it('adds nothing when every operand resolves', async () => {
    const result = await interpreter.run(
      plan([
        action('a'),
        {
          kind: 'if',
          id: 'check',
          condition: { left: '{{a.ran}}', op: 'eq', right: 'act.a' },
          guards: [guard('a')],
        },
        action('yes', {}, [guard('check', 0)]),
      ]),
      { externalUserId: 'u' },
    );
    expect(result.trace.find((entry) => entry.nodeId === 'check')).toBeUndefined();
    expect(result.outputs.yes).toEqual({ ran: 'act.yes', props: {} });
  });
});
