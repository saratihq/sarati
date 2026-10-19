import type { RuntimeStepKind } from '../database/entities/runtime-run.entity';
import type { DagNode, DagPlan, Guard } from './dag-plan';
import {
  replayRoutes,
  verdict,
  type CheckpointedRun,
  type RecordedOp,
  type RecordedStep,
  type Resumability,
} from './recovery-exposure';

const after = (source: string, port = 0): Guard[] => [{ source, port }];
const action = (id: string, guards: Guard[] = [], extra: Partial<DagNode> = {}): DagNode =>
  ({ kind: 'action', id, actionId: 'act.x', props: {}, guards, ...extra }) as DagNode;
const wait = (id: string, guards: Guard[] = []): DagNode => ({
  kind: 'waitForEvent',
  id,
  topic: 'go',
  timeoutMs: 60_000,
  guards,
});
const fork = (id: string, branches: DagNode[][], guards: Guard[] = []): DagNode => ({
  kind: 'parallel',
  id,
  branches: branches.map((nodes, i) => ({ id: `p#${id}|${i}`, nodes })),
  guards,
});
const plan = (...nodes: DagNode[]): DagPlan => ({ id: 'p', nodes });
const step = (stepKey: string, kind: RuntimeStepKind = 'action', pinned = false): RecordedStep => ({
  stepKey,
  kind,
  pinned,
});
// An action's op as DBOS returns it on replay: its result, the scope's value under `output`.
const answered = (name: string, output: unknown): RecordedOp => ({ name, output: { output }, failed: false });
interface Ran {
  steps: RecordedStep[];
  ops: RecordedOp[];
}
const ran = (steps: RecordedStep[], ops: Array<string | RecordedOp> = []): Ran => ({
  steps,
  ops: ops.map((op) => (typeof op === 'string' ? { name: op } : op)),
});
const resumability = (
  p: DagPlan,
  run: Ran,
  started: Partial<Omit<CheckpointedRun, 'plan'>> & { budget?: number } = {},
): Resumability =>
  verdict(
    { plan: p, pins: started.pins ?? {}, initialScope: started.initialScope ?? {} },
    run.ops,
    run.steps,
    started.budget,
  );
const agent = (...tools: Array<'workflow' | 'action'>): DagNode => ({
  kind: 'agent',
  id: 'ag',
  systemPrompt: 'help',
  model: { provider: 'claude', model: 'm' },
  maxSteps: 3,
  tools: tools.map((kind, i) =>
    kind === 'workflow'
      ? { kind, name: `t${i}`, workflowId: 'child' }
      : { kind, name: `t${i}`, actionId: 'act.x', props: {} },
  ),
  guards: [],
});
const turn = (round: number, ...calls: string[]): RecordedOp => ({
  name: `p:ag#${round}:model`,
  toolCalls: calls.map((name, i) => ({ id: `c${i}`, name })),
});

describe('resumability', () => {
  it('resumes a run whose steps ran one after another, its wait parked', () => {
    const p = plan(action('a'), wait('w', after('a')));
    expect(
      resumability(p, ran([step('a'), step('w', 'waitForEvent')], ['p:a', 'DBOS.recv', 'DBOS.sleep'])),
    ).toEqual({
      resumable: true,
    });
  });

  it('resumes a run parked before a fan-out, and refuses one that started inside it', () => {
    const p = plan(wait('w'), fork('fork', [[action('a')], [action('b')]], after('w')));
    expect(resumability(p, ran([step('w', 'waitForEvent')], ['DBOS.recv', 'DBOS.sleep']))).toEqual({
      resumable: true,
    });
    expect(
      resumability(p, ran([step('w', 'waitForEvent'), step('fork|0/a')], ['DBOS.recv', 'DBOS.sleep'])),
    ).toEqual({
      resumable: false,
      cause: 'side-by-side',
      reason: 'node a could run beside another step',
    });
    expect(resumability(p, ran([], ['p:fork|1/b']))).toMatchObject({ resumable: false });
  });

  it('refuses a step two unordered nodes could run beside, and resumes one only a router outcome apart', () => {
    expect(resumability(plan(action('a'), action('b')), ran([step('a')], ['p:a']))).toMatchObject({
      resumable: false,
    });
    const routed = plan(
      { kind: 'if', id: 'gate', condition: { left: '{{x}}', op: 'truthy' }, guards: [] },
      action('yes', after('gate', 0)),
      action('no', after('gate', 1)),
    );
    expect(resumability(routed, ran([step('gate', 'if'), step('yes')], ['p:yes']))).toEqual({
      resumable: true,
    });
  });

  it('refuses a fan-out only when two of its branches do work', () => {
    const lone = plan(
      fork('fork', [
        [action('a')],
        [{ kind: 'if', id: 'gate', condition: { left: '{{x}}', op: 'truthy' }, guards: [] }],
      ]),
    );
    expect(resumability(lone, ran([step('fork|0/a')], ['p:fork|0/a']))).toEqual({ resumable: true });
  });

  it('refuses an error lane beside its source’s siblings, and resumes one in a run of steps one after another', () => {
    const lane: DagPlan = { id: 'p#a:error', nodes: [action('h')] };
    const beside = plan(action('a', [], { onErrorBranch: lane }), action('b'));
    expect(resumability(beside, ran([step('a'), step('h')], ['p:a', 'p:h']))).toMatchObject({
      resumable: false,
    });
    const alone = plan(action('a', [], { onErrorBranch: lane }), action('b', after('a')));
    expect(resumability(alone, ran([step('a'), step('h')], ['p:a', 'p:h']))).toEqual({ resumable: true });
  });

  it('refuses a step in a loop body that fans out, and resumes one in a body of steps one after another', () => {
    const loop = (body: DagNode[]): DagPlan =>
      plan({
        kind: 'forEach',
        id: 'each',
        items: '{{xs}}',
        itemVar: 'x',
        body: { id: 'p#each', nodes: body },
        guards: [],
      });
    expect(
      resumability(loop([action('x'), action('y')]), ran([step('each#1/y')], ['p:each#1/y'])),
    ).toMatchObject({
      resumable: false,
    });
    expect(
      resumability(loop([action('x'), action('y', after('x'))]), ran([step('each#1/y')], ['p:each#1/y'])),
    ).toEqual({ resumable: true });
  });

  it('places an agent’s model and tool steps on the agent', () => {
    const p = plan({
      kind: 'agent',
      id: 'agent',
      systemPrompt: '',
      model: { provider: 'claude', model: 'm' },
      maxSteps: 3,
      tools: [],
      guards: [],
    } as unknown as DagNode);
    const ops = ['p:agent#0:model', 'p:agent#0:tool:c1', 'p:agent#1:model', 'p:agent#final:model'];
    expect(resumability(p, ran([step('agent', 'agent')], ops))).toEqual({ resumable: true });
  });

  it('fails closed on a step or an op it can place on no node, or on more than one', () => {
    const p = plan(action('a'), wait('w', after('a')));
    expect(resumability(p, ran([step('nope')], ['p:a']))).toEqual({
      resumable: false,
      cause: 'unmatched',
      reason: 'step nope matches no node of its plan',
    });
    expect(resumability(p, ran([], ['other:a']))).toEqual({
      resumable: false,
      cause: 'unmatched',
      reason: 'op other:a matches no node of its plan',
    });
    const clash = plan(action('fork|0/a'), fork('fork', [[action('a')], [action('b')]], after('fork|0/a')));
    expect(resumability(clash, ran([step('fork|0/a')], ['p:fork|0/a']))).toEqual({
      resumable: false,
      cause: 'unmatched',
      reason: 'step fork|0/a matches 2 nodes of its plan',
    });
    const shared = (source: string): Partial<DagNode> => ({
      onErrorBranch: { id: `p#${source}:error`, nodes: [action('h')] },
    });
    const copies = plan(action('a', [], shared('a')), action('b', after('a'), shared('b')));
    expect(resumability(copies, ran([step('h')], ['p:a']))).toMatchObject({ resumable: false });
  });

  it('fails closed on a receive or a sleep no started wait or delay explains', () => {
    const p = plan(action('a'), wait('w', after('a')));
    expect(resumability(p, ran([step('a')], ['p:a', 'DBOS.recv']))).toEqual({
      resumable: false,
      cause: 'unmatched',
      reason: 'it recorded a receive or a sleep no started wait or delay explains',
    });
    const short = plan({ kind: 'delay', id: 'nap', ms: 5_000, guards: [] });
    expect(resumability(short, ran([step('nap', 'delay')], ['DBOS.sleep']))).toEqual({ resumable: true });
    expect(resumability(short, ran([step('nap', 'delay')], ['DBOS.recv', 'DBOS.sleep']))).toMatchObject({
      resumable: false,
    });
  });

  it('refuses an agent refused a sub-workflow call once anything was recorded after it, since a replay makes it', () => {
    const p = plan(agent('workflow', 'action'));
    const refused = {
      resumable: false,
      cause: 'refused-call',
      reason: 'node ag was refused a sub-workflow call that a replay could make',
    };
    expect(resumability(p, ran([step('ag', 'agent')], [turn(0, 't0'), turn(1)]))).toEqual(refused);
    expect(resumability(p, ran([step('ag', 'agent')], [turn(0, 't0', 't1'), 'p:ag#0:tool:c1']))).toEqual(
      refused,
    );
    expect(resumability(p, ran([step('ag', 'agent')], [turn(0, 't0')]))).toEqual({ resumable: true });
    expect(
      resumability(
        p,
        ran([step('ag', 'agent')], [turn(0, 't0', 't1'), 'p:ag#0:tool:c0', 'p:ag#0:tool:c1', turn(1)]),
      ),
    ).toEqual({ resumable: true });
    expect(resumability(p, ran([step('ag', 'agent')], [turn(0, 't1', 'ghost'), turn(1)]))).toEqual({
      resumable: true,
    });
  });

  it("refuses a model turn whose tool calls can't be read only where a sub-workflow call could hide in it", () => {
    const unread: RecordedOp = { name: 'p:ag#0:model', toolCalls: null };
    expect(resumability(plan(agent('workflow')), ran([step('ag', 'agent')], [unread]))).toEqual({
      resumable: false,
      cause: 'unmatched',
      reason: "node ag recorded a model turn whose tool calls can't be read",
    });
    expect(resumability(plan(agent('action')), ran([step('ag', 'agent')], [unread]))).toEqual({
      resumable: true,
    });
  });

  it('resumes a run that recorded no op whatever its rows, and refuses one with ops but no run row', () => {
    const run: CheckpointedRun = { plan: plan(action('a'), action('b')), pins: {}, initialScope: {} };
    expect(verdict(run, [], null)).toEqual({ resumable: true });
    expect(verdict(run, [], [step('a'), step('b')])).toEqual({ resumable: true });
    expect(verdict(run, [{ name: 'p:a' }], null)).toEqual({
      resumable: false,
      cause: 'unmatched',
      reason: 'it has no run row',
    });
  });

  it('counts no pinned leaf as a partner, as it replays its pin and issues no op', () => {
    const p = plan(action('pinned'), action('a'), wait('w', after('a')));
    const run = ran(
      [step('pinned', 'action', true), step('a'), step('w', 'waitForEvent')],
      ['p:a', 'DBOS.recv', 'DBOS.sleep'],
    );
    expect(resumability(p, run, { pins: { pinned: { done: true } } })).toEqual({ resumable: true });
    expect(resumability(p, run)).toMatchObject({ resumable: false, cause: 'side-by-side' });
  });

  it('refuses a call refused for the budget only while its replay would still have budget to make it', () => {
    const p = plan(agent('workflow'));
    const spentThenRefused = ran(
      [step('ag', 'agent')],
      [turn(0, 't0'), 'p:ag#0:tool:c0', turn(1, 't0'), turn(2)],
    );
    // Its own agent spent the one call there was: a replay spends it again and refuses the same call.
    expect(resumability(p, spentThenRefused, { budget: 1 })).toEqual({ resumable: true });
    expect(resumability(p, spentThenRefused, { budget: 2 })).toMatchObject({ cause: 'refused-call' });
    const sameTurn = ran([step('ag', 'agent')], [turn(0, 't0', 't0'), 'p:ag#0:tool:c0', turn(1)]);
    expect(resumability(p, sameTurn, { budget: 1 })).toEqual({ resumable: true });
    expect(resumability(p, sameTurn, { budget: 2 })).toMatchObject({ cause: 'refused-call' });
  });

  it('judges a router on the port it takes on replay, from the scope it starts with', () => {
    const p = plan(
      { kind: 'if', id: 'gate', condition: { left: '{{trigger.go}}', op: 'truthy' }, guards: [] },
      action('a', after('gate', 0)),
      action('b'),
      wait('w', after('b')),
    );
    const run = ran([step('b'), step('w', 'waitForEvent')], ['p:b', 'DBOS.recv', 'DBOS.sleep']);
    expect(resumability(p, run, { initialScope: { trigger: { go: false } } })).toEqual({ resumable: true });
    expect(resumability(p, run, { initialScope: { trigger: { go: true } } })).toMatchObject({
      cause: 'side-by-side',
    });
    expect(resumability(p, run)).toMatchObject({ cause: 'side-by-side' });
  });

  it('judges a router on the output its op recorded, decoded as the replay decodes it, else on every port', () => {
    const fed = plan(
      action('prep'),
      { kind: 'if', id: 'gate', condition: { left: '{{prep.go}}', op: 'truthy' }, guards: after('prep') },
      action('a', after('gate', 0)),
      action('b', after('prep')),
      wait('w', after('b')),
    );
    const recorded = (prep?: RecordedOp) =>
      ran(
        [step('prep'), step('b'), step('w', 'waitForEvent')],
        [...(prep ? [prep] : []), 'p:b', 'DBOS.recv', 'DBOS.sleep'],
      );
    expect(resumability(fed, recorded(answered('p:prep', { go: false })))).toEqual({ resumable: true });
    expect(resumability(fed, recorded(answered('p:prep', { go: true })))).toMatchObject({
      cause: 'side-by-side',
    });
    // A Date has no keys of its own, so it reads as false; its JSON form, an ISO string, would read as true.
    expect(resumability(fed, recorded(answered('p:prep', { go: new Date(0) })))).toEqual({ resumable: true });
    // An output that only looks capped is judged on what it holds.
    expect(resumability(fed, recorded(answered('p:prep', { truncated: true, go: false })))).toEqual({
      resumable: true,
    });
    expect(resumability(fed, recorded({ name: 'p:prep', failed: true }))).toMatchObject({
      cause: 'side-by-side',
    });
    expect(resumability(fed, recorded())).toMatchObject({ cause: 'side-by-side' });
  });

  it("judges a router on a code step's and a called workflow's whole result, as the interpreter hands it to scope", () => {
    const sources: DagNode[] = [
      { kind: 'code', id: 'prep', code: 'return 1', guards: [] },
      { kind: 'callWorkflow', id: 'prep', workflowId: 'child', input: {}, guards: [] },
    ];
    for (const source of sources) {
      const fed = plan(
        source,
        { kind: 'if', id: 'gate', condition: { left: '{{prep.go}}', op: 'truthy' }, guards: after('prep') },
        action('a', after('gate', 0)),
        action('b', after('prep')),
        wait('w', after('b')),
      );
      // Only an action's result is unwrapped to its `output`: here that field is a decoy.
      const prep: RecordedOp = { name: 'p:prep', output: { go: false, output: { go: true } }, failed: false };
      const run = ran(
        [step('prep', source.kind as RuntimeStepKind), step('b'), step('w', 'waitForEvent')],
        [prep, 'p:b', 'DBOS.recv', 'DBOS.sleep'],
      );
      expect(resumability(fed, run)).toEqual({ resumable: true });
    }
  });

  it('reads a pinned step a router routed away as undefined, as its replay does, never its pin', () => {
    const p = plan(
      { kind: 'if', id: 'gate', condition: { left: '{{trigger.go}}', op: 'truthy' }, guards: [] },
      action('pinned', after('gate', 1)),
      action('q', after('gate', 0)),
      action('join', [...after('pinned'), ...after('q')]),
      { kind: 'if', id: 'r', condition: { left: '{{pinned.v}}', op: 'truthy' }, guards: after('join') },
      action('solo', after('r', 0)),
      action('b1', after('r', 1)),
      action('b2', after('r', 1)),
    );
    const run: CheckpointedRun = {
      plan: p,
      pins: { pinned: { v: true } },
      initialScope: { trigger: { go: true } },
    };
    const ops = [answered('p:q', {}), answered('p:join', {}), { name: 'p:b1' }];
    expect(replayRoutes(run, ops)).toEqual(
      new Map([
        ['gate', 0],
        ['r', 1],
      ]),
    );
    expect(verdict(run, ops, [step('q'), step('join'), step('b1')])).toMatchObject({ cause: 'side-by-side' });
  });

  it('applies no pin to a step that is no leaf, as its replay applies none', () => {
    const p = plan(
      wait('w'),
      { kind: 'if', id: 'r', condition: { left: '{{w.v}}', op: 'truthy' }, guards: after('w') },
      action('solo', after('r', 0)),
      action('b1', after('r', 1)),
      action('b2', after('r', 1)),
    );
    const run: CheckpointedRun = { plan: p, pins: { w: { v: true } }, initialScope: {} };
    const ops = [{ name: 'DBOS.sleep' }, { name: 'DBOS.recv' }, { name: 'p:b1' }];
    expect(replayRoutes(run, ops)).toEqual(new Map());
    expect(verdict(run, ops, [step('w', 'waitForEvent'), step('b1')])).toMatchObject({
      cause: 'side-by-side',
    });
  });

  it('passes over pinned and routing rows', () => {
    const p = plan(action('a'));
    expect(
      resumability(
        p,
        ran([step('ghost', 'action', true), step('gate#0:condition', 'if'), step('a')], ['p:a']),
      ),
    ).toEqual({
      resumable: true,
    });
  });
});
