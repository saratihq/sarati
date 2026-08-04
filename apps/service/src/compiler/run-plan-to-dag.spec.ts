import { PassThroughDurableStep, type DurableStep } from '../providers/durable-step';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import { DagInterpreter } from '../runtime/dag-interpreter';
import type { DagActionNode, DagForEachNode, DagIfNode, DagParallelNode, DagPlan } from '../runtime/dag-plan';
import type { RunOptions } from '../runtime/base-plan-interpreter';
import type { RunPlan, RunResult } from '../runtime/run-plan';
import { runPlanToDag } from './run-plan-to-dag';

/**
 * `runPlanToDag` — the lowering that preserves the raw client-supplied `RunPlan` API. Two proofs:
 * STRUCTURE (the flat `DagPlan` a nested plan lowers to — guards, nesting, OR-join exits) and
 * EXECUTION (every raw-plan shape runs correctly through `runPlanToDag → DagInterpreter`).
 */

/** Deterministic echo provider: `{ ran, props }` per action; `fail(actionId)` throws. */
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

const act = (id: string, props: Record<string, unknown> = {}): RunPlan['nodes'][number] => ({
  kind: 'action',
  id,
  actionId: `test.${id}`,
  props,
});

function runDag(
  plan: RunPlan,
  opts: Partial<RunOptions> = {},
  provider: ManagedIntegrationProvider = echoProvider(),
): Promise<RunResult> {
  return new DagInterpreter(provider).run(runPlanToDag(plan), { externalUserId: 'u', ...opts });
}

const byId = (plan: DagPlan, id: string): DagActionNode =>
  plan.nodes.find((n) => n.id === id) as DagActionNode;

describe('runPlanToDag — structure', () => {
  it('chains sequential siblings: each depends on the previous sibling', () => {
    const dag = runPlanToDag({ id: 'lin', nodes: [act('a'), act('b'), act('c')] });
    expect(dag.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(byId(dag, 'a').guards).toEqual([]);
    expect(byId(dag, 'b').guards).toEqual([{ source: 'a', port: 0 }]);
    expect(byId(dag, 'c').guards).toEqual([{ source: 'b', port: 0 }]);
  });

  it('gates if.then on port 0, if.else on port 1; the node after the if OR-joins both exits', () => {
    const dag = runPlanToDag({
      id: 'if',
      nodes: [
        {
          kind: 'if',
          id: 'gate',
          condition: { left: '{{x}}', op: 'truthy' },
          then: [act('t')],
          else: [act('e')],
        },
        act('after'),
      ],
    });
    expect(dag.nodes.map((n) => n.id)).toEqual(['gate', 't', 'e', 'after']);
    expect((byId(dag, 'gate') as unknown as DagIfNode).kind).toBe('if');
    expect(byId(dag, 't').guards).toEqual([{ source: 'gate', port: 0 }]);
    expect(byId(dag, 'e').guards).toEqual([{ source: 'gate', port: 1 }]);
    // after runs once whichever lane executed (OR-join over the two branch exits).
    expect(byId(dag, 'after').guards).toEqual([
      { source: 't', port: 0 },
      { source: 'e', port: 0 },
    ]);
  });

  it('an EMPTY branch exits at the if port, so the continuation still fires when that branch is taken', () => {
    const dag = runPlanToDag({
      id: 'empty-else',
      nodes: [
        { kind: 'if', id: 'gate', condition: { left: '{{x}}', op: 'truthy' }, then: [act('t')] },
        act('after'),
      ],
    });
    // no else lane → the else "exit" is the if's own port 1.
    expect(byId(dag, 'after').guards).toEqual([
      { source: 't', port: 0 },
      { source: 'gate', port: 1 },
    ]);
  });

  it('keeps forEach body / parallel branches / onErrorBranch as nested sub-plans with ungated roots', () => {
    const dag = runPlanToDag({
      id: 'nested',
      nodes: [
        {
          kind: 'forEach',
          id: 'each',
          items: '{{seed.items}}',
          itemVar: 'it',
          body: [act('call', { v: '{{it}}' })],
        },
        {
          kind: 'parallel',
          id: 'fork',
          branches: [[act('l')], [act('r')]],
        },
        { kind: 'action', id: 'boom', actionId: 'test.boom', props: {}, onErrorBranch: [act('handler')] },
      ],
    });
    const each = byId(dag, 'each') as unknown as DagForEachNode;
    expect(each.body.nodes.map((n) => n.id)).toEqual(['call']);
    expect(each.body.nodes[0]!.guards).toEqual([]);
    const fork = byId(dag, 'fork') as unknown as DagParallelNode;
    expect(fork.branches.map((b) => b.nodes.map((n) => n.id))).toEqual([['l'], ['r']]);
    expect(fork.branches[0]!.nodes[0]!.guards).toEqual([]);
    const lane = byId(dag, 'boom').onErrorBranch;
    expect(lane?.nodes.map((n) => n.id)).toEqual(['handler']);
    expect(lane?.nodes[0]!.guards).toEqual([]);
  });

  it('every guard source precedes its node (topological validity)', () => {
    const dag = runPlanToDag({
      id: 'topo',
      nodes: [
        {
          kind: 'if',
          id: 'g',
          condition: { left: '{{x}}', op: 'truthy' },
          then: [act('t1'), act('t2')],
          else: [act('e1')],
        },
        act('after'),
      ],
    });
    const index = new Map(dag.nodes.map((n, i) => [n.id, i]));
    for (const node of dag.nodes) {
      for (const g of node.guards) {
        expect(index.has(g.source)).toBe(true);
        expect(index.get(g.source)!).toBeLessThan(index.get(node.id)!);
      }
    }
  });
});

describe('runPlanToDag — execution (raw plans run correctly on the one engine)', () => {
  it('linear: passes an upstream output into a downstream step', async () => {
    const result = await runDag({
      id: 'lin',
      nodes: [act('a'), act('b', { up: '{{a.ran}}' }), act('c', { up: '{{b.ran}}' })],
    });
    expect(result.outputs.c).toEqual({ ran: 'test.c', props: { up: 'test.b' } });
    expect(result.trace.map((t) => t.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('if: runs `then` when the condition holds and `else` when it fails; `after` runs in both', async () => {
    const plan = (right: string): RunPlan => ({
      id: 'if',
      nodes: [
        act('seed', { v: 'go' }),
        {
          kind: 'if',
          id: 'gate',
          condition: { left: '{{seed.ran}}', op: 'eq', right },
          then: [act('yes')],
          else: [act('no')],
        },
        act('after', { via: 'x' }),
      ],
    });
    const hit = await runDag(plan('test.seed'));
    expect(hit.outputs.yes).toBeDefined();
    expect(hit.outputs.no).toBeUndefined();
    expect(hit.outputs.after).toBeDefined();

    const miss = await runDag(plan('nope'));
    expect(miss.outputs.yes).toBeUndefined();
    expect(miss.outputs.no).toBeDefined();
    expect(miss.outputs.after).toBeDefined();
  });

  it('nested if: the taken path runs, both dead lanes are skipped, the tail runs', async () => {
    const plan: RunPlan = {
      id: 'nested',
      nodes: [
        {
          kind: 'if',
          id: 'outer',
          condition: { left: '{{o}}', op: 'truthy' },
          then: [
            {
              kind: 'if',
              id: 'inner',
              condition: { left: '{{i}}', op: 'truthy' },
              then: [act('x')],
              else: [act('y')],
            },
            act('z'),
          ],
          else: [act('w')],
        },
        act('done'),
      ],
    };
    const result = await runDag(plan, { initialScope: { o: true, i: false } });
    expect(result.outputs.x).toBeUndefined(); // inner then dead
    expect(result.outputs.y).toBeDefined(); // inner else taken
    expect(result.outputs.z).toBeDefined(); // continuation after inner
    expect(result.outputs.w).toBeUndefined(); // outer else dead
    expect(result.outputs.done).toBeDefined(); // tail runs after outer
  });

  it('forEach: runs the body once per element, binding the item; output is the per-iteration array', async () => {
    const plan: RunPlan = {
      id: 'loop',
      nodes: [
        // `seed` echoes its props, so `{{seed.props.list}}` resolves to the array.
        act('seed', { list: ['a', 'b', 'c'] }),
        {
          kind: 'forEach',
          id: 'each',
          items: '{{seed.props.list}}',
          itemVar: 'letter',
          body: [act('call', { v: '{{letter}}' })],
        },
      ],
    };
    const result = await runDag(plan);
    const iterations = result.outputs.each as Array<{ call: { props: { v: string } } }>;
    expect(iterations.map((it) => it.call.props.v)).toEqual(['a', 'b', 'c']);
  });

  it('parallel: runs branches and merges their outputs back into scope', async () => {
    const result = await runDag({
      id: 'fan',
      nodes: [
        { kind: 'parallel', id: 'fork', branches: [[act('left', { s: 'L' })], [act('right', { s: 'R' })]] },
      ],
    });
    expect(result.outputs.left).toEqual({ ran: 'test.left', props: { s: 'L' } });
    expect(result.outputs.right).toEqual({ ran: 'test.right', props: { s: 'R' } });
  });

  it('error lane (ADR 0020): the lane runs, the main successor is skipped, the run completes', async () => {
    const plan: RunPlan = {
      id: 'err',
      nodes: [
        {
          kind: 'action',
          id: 'boom',
          actionId: 'test.boom',
          props: {},
          onErrorBranch: [act('handler', { m: '{{boom.error.message}}' })],
        },
        act('after', { m: 'MAIN' }),
      ],
    };
    const result = await runDag(
      plan,
      {},
      echoProvider((id) => id === 'test.boom'),
    );
    expect((result.outputs.handler as { props: { m: string } }).props.m).toContain('boom:test.boom');
    expect(result.outputs.after).toBeUndefined(); // never both lanes
  });

  it('continue-on-fail (ADR 0020): a tolerated throw is captured; the run goes on', async () => {
    const plan: RunPlan = {
      id: 'cont',
      nodes: [
        { kind: 'action', id: 'boom', actionId: 'test.boom', props: {}, onError: 'continue' },
        act('after', { m: '{{boom.error.message}}' }),
      ],
    };
    const result = await runDag(
      plan,
      {},
      echoProvider((id) => id === 'test.boom'),
    );
    expect((result.outputs.boom as { __errored: boolean }).__errored).toBe(true);
    expect((result.outputs.after as { props: { m: string } }).props.m).toContain('boom:test.boom');
  });

  it('waitForEvent: suspends until an event is delivered, then binds the payload', async () => {
    const durable = new PassThroughDurableStep();
    const plan: RunPlan = {
      id: 'hitl',
      nodes: [
        { kind: 'waitForEvent', id: 'approval', topic: 'approve', timeoutMs: 2000 },
        act('act', { d: '{{approval.decision}}' }),
      ],
    };
    const runPromise = runDag(plan, { durable });
    for (let i = 0; i < 50 && !durable.deliver('approve', { decision: 'approved' }); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await runPromise;
    expect(result.outputs.approval).toEqual({ decision: 'approved' });
    expect((result.outputs.act as { props: { d: string } }).props.d).toBe('approved');
  });

  it('waitForEvent: resolves to null on timeout', async () => {
    const durable = new PassThroughDurableStep();
    const plan: RunPlan = {
      id: 'to',
      nodes: [{ kind: 'waitForEvent', id: 'wait', topic: 'never', timeoutMs: 20 }],
    };
    const result = await runDag(plan, { durable });
    expect(result.outputs.wait).toBeNull();
  });

  it('delay: pauses via the DurableStep between actions', async () => {
    const sleeps: Array<{ name: string; ms: number }> = [];
    const recording: DurableStep = {
      run: (_n, fn) => fn(),
      sleep: (name, ms) => {
        sleeps.push({ name, ms });
        return Promise.resolve();
      },
      waitForEvent: () => Promise.resolve(null),
    };
    const plan: RunPlan = {
      id: 'd',
      nodes: [act('before'), { kind: 'delay', id: 'wait', ms: 50 }, act('after')],
    };
    await runDag(plan, { durable: recording });
    expect(sleeps).toEqual([{ name: 'd:wait', ms: 50 }]);
  });

  it('pinning (ADR 0021): a pinned action replays its output and never calls the provider', async () => {
    const seen: string[] = [];
    const recording: DurableStep = {
      run: <T>(name: string, fn: () => Promise<T>) => {
        seen.push(name);
        return fn();
      },
      sleep: () => Promise.resolve(),
      waitForEvent: () => Promise.resolve(null),
    };
    const plan: RunPlan = {
      id: 'pin',
      nodes: [act('fetch'), act('push', { up: '{{fetch.id}}' })],
    };
    const result = await runDag(plan, {
      durable: recording,
      pins: { fetch: { id: 99 } },
    });
    expect(result.outputs.fetch).toEqual({ id: 99 });
    expect((result.outputs.push as { props: { up: number } }).props.up).toBe(99);
    // Only `push` went through the durable provider step — `fetch` was replayed.
    expect(seen).toEqual(['pin:push']);
  });

  it('durable keys stay path-scoped across a forEach (stable across replay)', async () => {
    const seen: string[] = [];
    const recording: DurableStep = {
      run: <T>(name: string, fn: () => Promise<T>) => {
        seen.push(name);
        return fn();
      },
      sleep: () => Promise.resolve(),
      waitForEvent: () => Promise.resolve(null),
    };
    const plan: RunPlan = {
      id: 'p',
      nodes: [
        act('seed', { items: ['a', 'b', 'c'] }),
        {
          kind: 'forEach',
          id: 'each',
          items: '{{seed.props.items}}',
          itemVar: 'x',
          body: [act('call', { v: '{{x}}' })],
        },
      ],
    };
    await runDag(plan, { durable: recording });
    expect(seen).toEqual(['p:seed', 'p:each#0/call', 'p:each#1/call', 'p:each#2/call']);
  });

  it('retry-on-fail (ADR 0020): recovers after transient failures, then exhausts', async () => {
    let calls = 0;
    const flaky: ManagedIntegrationProvider = {
      key: 'mock',
      runAction: () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new Error(`transient ${calls}`))
          : Promise.resolve({ output: { ok: true, onCall: calls } });
      },
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    };
    const recover: RunPlan = {
      id: 'flaky',
      nodes: [
        { kind: 'action', id: 'a', actionId: 'mock.do', props: {}, retry: { maxAttempts: 3, backoffMs: 0 } },
      ],
    };
    const result = await runDag(recover, {}, flaky);
    expect(calls).toBe(3);
    expect(result.outputs.a).toEqual({ ok: true, onCall: 3 });

    calls = 0;
    const exhaust: RunPlan = {
      id: 'flaky2',
      nodes: [
        { kind: 'action', id: 'a', actionId: 'mock.do', props: {}, retry: { maxAttempts: 2, backoffMs: 0 } },
      ],
    };
    await expect(runDag(exhaust, {}, flaky)).rejects.toThrow(/transient/);
    expect(calls).toBe(2);
  });

  it('rejects a plan with duplicate node ids', async () => {
    const plan: RunPlan = { id: 'dup', nodes: [act('a'), act('a')] };
    await expect(runDag(plan)).rejects.toThrow(/Duplicate node id "a"/);
  });
});
