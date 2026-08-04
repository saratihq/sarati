import type { ManagedIntegrationProvider, RunActionInput } from '../providers/managed-integration-provider';
import { DagInterpreter } from './dag-interpreter';
import type { DagActionNode, DagNode, DagPlan, Guard } from './dag-plan';

/**
 * The bounded concurrent wave scheduler (ADR 0023 slice 5), on three claims: OUTPUT-EQUIVALENCE
 * (limit 8 deep-equals limit 1, the sequential reference, across every control shape); REAL
 * CONCURRENCY (independent branches overlap — a live in-flight gauge reaches 2, and wall-time is
 * ≈max(branch) not sum); and CONCURRENT ERROR HANDLING (a fatal error and an ErrorLaneHalt each
 * stop NEW work but await in-flight siblings, so no promise floats and no write is lost).
 *
 * Trace order is interleaved under concurrency, so NO assertion reads it.
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

/** Fails the first `succeedOnCall - 1` calls, then succeeds — for the retry shape. */
function flakyProvider(succeedOnCall: number): ManagedIntegrationProvider {
  let calls = 0;
  return {
    key: 'flaky',
    runAction: () => {
      calls += 1;
      return calls < succeedOnCall
        ? Promise.reject(new Error(`transient ${calls}`))
        : Promise.resolve({ output: { onCall: calls } });
    },
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}

/**
 * A provider that gauges live concurrency: each action bumps an in-flight counter,
 * waits `delayMs`, then decrements — so `max()` is the peak overlap observed.
 */
function gauge(delayMs: number): { provider: ManagedIntegrationProvider; max: () => number } {
  let active = 0;
  let max = 0;
  return {
    max: () => max,
    provider: {
      key: 'gauge',
      runAction: async (input: RunActionInput) => {
        active += 1;
        if (active > max) max = active;
        await new Promise((r) => setTimeout(r, delayMs));
        active -= 1;
        return { output: { ran: input.actionId } };
      },
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    },
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
const ifNode = (id: string, flag: boolean, guards: Guard[] = []): DagNode => ({
  kind: 'if',
  id,
  condition: { left: flag, op: 'truthy' },
  guards,
});
const forEachNode = (
  id: string,
  items: string,
  itemVar: string,
  body: DagNode[],
  guards: Guard[],
): DagNode => ({ kind: 'forEach', id, items, itemVar, body: { id: `${id}#body`, nodes: body }, guards });
const parallelNode = (id: string, branches: DagNode[][], guards: Guard[]): DagNode => ({
  kind: 'parallel',
  id,
  branches: branches.map((nodes, i) => ({ id: `${id}#${i}`, nodes })),
  guards,
});

const plan = (nodes: DagNode[]): DagPlan => ({ id: 'dag', nodes });
const interp = (provider: ManagedIntegrationProvider, limit: number): DagInterpreter =>
  new DagInterpreter(provider, undefined, limit);

// ─── 1. OUTPUT-EQUIVALENCE — concurrent (8) deep-equals sequential (1) ───────
describe('DagInterpreter slice 5 — output-equivalence (limit 8 ≡ limit 1)', () => {
  const cases: Array<{ name: string; plan: () => DagPlan; provider: () => ManagedIntegrationProvider }> = [
    {
      name: 'linear chain a→b→c',
      plan: () =>
        plan([
          action('a'),
          action('b', { up: '{{a.ran}}' }, [guard('a')]),
          action('c', { up: '{{b.ran}}' }, [guard('b')]),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'fan-out a→x,y',
      plan: () =>
        plan([
          action('a'),
          action('x', { up: '{{a.ran}}' }, [guard('a')]),
          action('y', { up: '{{a.ran}}' }, [guard('a')]),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'fan-in (no IF) a,b→c',
      plan: () =>
        plan([
          action('a'),
          action('b'),
          action('c', { l: '{{a.ran}}', r: '{{b.ran}}' }, [guard('a'), guard('b')]),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'diamond split→m1,m2→join',
      plan: () =>
        plan([
          action('split'),
          action('m1', { up: '{{split.ran}}' }, [guard('split')]),
          action('m2', { up: '{{split.ran}}' }, [guard('split')]),
          action('join', { l: '{{m1.ran}}', r: '{{m2.ran}}' }, [guard('m1'), guard('m2')]),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'diamond + IF OR-join (then live, else skipped)',
      plan: () =>
        plan([
          ifNode('check', true),
          action('t', {}, [guard('check', 0)]),
          action('e', {}, [guard('check', 1)]),
          action('join', { t: '{{t.ran}}', e: '{{e.ran}}' }, [guard('t'), guard('e')]),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'reconvergence: IF-lane join + external inflow (else live)',
      plan: () =>
        plan([
          ifNode('check', false),
          action('T', {}, [guard('check', 0)]),
          action('E', {}, [guard('check', 1)]),
          action('D'),
          action('J', { t: '{{T.ran}}', e: '{{E.ran}}', d: '{{D.ran}}' }, [
            guard('T'),
            guard('E'),
            guard('D'),
          ]),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'forEach nested body per element',
      plan: () =>
        plan([
          action('seed', { items: ['a', 'b', 'c'] }),
          forEachNode(
            'each',
            '{{seed.props.items}}',
            'letter',
            [action('call', { v: '{{letter}}' }, [])],
            [guard('seed')],
          ),
        ]),
      provider: () => echoProvider(),
    },
    {
      name: 'parallel branches merge back',
      plan: () =>
        plan([parallelNode('fork', [[action('left', { s: 'L' })], [action('right', { s: 'R' })]], [])]),
      provider: () => echoProvider(),
    },
    {
      // A dependent chain, so the halting error can't race a sibling — the ONE shape
      // where the two limits could otherwise diverge.
      name: 'error lane (dependent chain): lane runs, main successor skipped',
      plan: () =>
        plan([
          action('boom', {}, [], {
            onErrorBranch: { id: 'lane', nodes: [action('handler', { m: '{{boom.error.message}}' }, [])] },
          }),
          action('after', {}, [guard('boom')]),
        ]),
      provider: () => echoProvider((id) => id === 'act.boom'),
    },
    {
      name: 'continue-on-fail: error captured, run goes on',
      plan: () =>
        plan([
          action('boom', {}, [], { onError: 'continue' }),
          action('after', { m: '{{boom.error.message}}' }, [guard('boom')]),
        ]),
      provider: () => echoProvider((id) => id === 'act.boom'),
    },
    {
      name: 'retry then succeed (single node)',
      plan: () => plan([action('a', {}, [], { retry: { maxAttempts: 3, backoffMs: 0 } })]),
      provider: () => flakyProvider(3),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: concurrent outputs ≡ sequential outputs`, async () => {
      const sequential = await interp(c.provider(), 1).run(c.plan(), { externalUserId: 'u' });
      const concurrent = await interp(c.provider(), 8).run(c.plan(), { externalUserId: 'u' });
      expect(concurrent.outputs).toEqual(sequential.outputs);
    });
  }
});

// ─── 2. REAL CONCURRENCY — independent branches actually overlap ─────────────
describe('DagInterpreter slice 5 — real concurrency (overlap is real, not cosmetic)', () => {
  // Two independent 2-node branches: a1→a2 and b1→b2 (no cross-guards).
  const twoBranches = (): DagPlan =>
    plan([action('a1'), action('a2', {}, [guard('a1')]), action('b1'), action('b2', {}, [guard('b1')])]);

  it('peak in-flight reaches 2 at limit>1 and stays 1 at limit 1', async () => {
    const g8 = gauge(20);
    const concurrent = await interp(g8.provider, 8).run(twoBranches(), { externalUserId: 'u' });
    expect(g8.max()).toBe(2); // the a-branch and b-branch overlapped

    const g1 = gauge(20);
    await interp(g1.provider, 1).run(twoBranches(), { externalUserId: 'u' });
    expect(g1.max()).toBe(1); // strictly one node in flight (byte-parity fallback)

    // Overlap changes nothing observable in the outputs.
    expect(concurrent.outputs.a2).toBeDefined();
    expect(concurrent.outputs.b2).toBeDefined();
  });

  it('wall-time is ≈max(branch), not sum: concurrent finishes faster', async () => {
    const g8 = gauge(40);
    const startC = Date.now();
    await interp(g8.provider, 8).run(twoBranches(), { externalUserId: 'u' });
    const concurrentMs = Date.now() - startC;

    const g1 = gauge(40);
    const startS = Date.now();
    await interp(g1.provider, 1).run(twoBranches(), { externalUserId: 'u' });
    const sequentialMs = Date.now() - startS;

    // Sequential = 4 delays (~160ms); concurrent = 2 overlapped waves (~80ms).
    expect(g8.max()).toBe(2);
    expect(g1.max()).toBe(1);
    expect(concurrentMs).toBeLessThan(sequentialMs);
  });
});

// ─── 3. CONCURRENT ERROR HANDLING — drain in-flight, no floating promise ─────
describe('DagInterpreter slice 5 — concurrent error handling', () => {
  it('a FATAL error stops new work, AWAITS the in-flight sibling, then fails the run', async () => {
    let siblingSettled = false;
    const provider: ManagedIntegrationProvider = {
      key: 'mix',
      runAction: async (input: RunActionInput) => {
        if (input.actionId === 'act.boom') {
          await Promise.resolve(); // let the sibling start first, then blow up
          throw new Error('fatal-boom');
        }
        await new Promise((r) => setTimeout(r, 25)); // still in flight when boom fails
        siblingSettled = true;
        return { output: { done: true } };
      },
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    };
    // boom + slow are independent roots — both launch at limit 8.
    const run = interp(provider, 8).run(plan([action('boom'), action('slow')]), { externalUserId: 'u' });
    await expect(run).rejects.toThrow('fatal-boom'); // the fatal error surfaces
    expect(siblingSettled).toBe(true); // …but only after the in-flight sibling drained
  });

  it('an ErrorLaneHalt stops new work, AWAITS the in-flight sibling, then COMPLETES the run', async () => {
    let siblingSettled = false;
    const provider: ManagedIntegrationProvider = {
      key: 'mix',
      runAction: async (input: RunActionInput) => {
        if (input.actionId === 'act.boom') {
          await Promise.resolve();
          throw new Error('boom-for-lane');
        }
        if (input.actionId === 'act.slow') {
          await new Promise((r) => setTimeout(r, 25));
          siblingSettled = true;
          return { output: { done: true } };
        }
        return { output: { ran: input.actionId, props: input.props } }; // the lane handler
      },
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    };
    const lane: DagPlan = { id: 'lane', nodes: [action('handler', { m: '{{boom.error.message}}' }, [])] };
    const result = await interp(provider, 8).run(
      plan([action('boom', {}, [], { onErrorBranch: lane }), action('slow')]),
      { externalUserId: 'u' },
    );
    // ErrorLaneHalt is swallowed by runProgram → the run completes successfully.
    expect((result.outputs.handler as { props: { m: string } }).props.m).toContain('boom-for-lane');
    expect(siblingSettled).toBe(true); // sibling drained before the halt surfaced
    expect(result.outputs.slow).toEqual({ done: true }); // its in-flight write survived
  });
});
