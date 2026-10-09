import type { DagNode, DagPlan, Guard } from './dag-plan';
import { eventMessage, isStepTopic, waitsRoutedByStep } from './event-wait';

const wait = (id: string, topic: string, guards: Guard[] = []): DagNode => ({
  kind: 'waitForEvent',
  id,
  topic,
  timeoutMs: 1_000,
  guards,
});
const after = (source: string, port = 0): Guard[] => [{ source, port }];
const plan = (nodes: DagNode[]): DagPlan => ({ id: 'p', nodes });
const routedIds = (p: DagPlan): string[] => [...waitsRoutedByStep(p)].map((n) => n.id).sort();

describe('waitsRoutedByStep', () => {
  it('keeps waits one after another on one topic on the topic itself', () => {
    expect(
      routedIds(plan([wait('manager', 'approval'), wait('director', 'approval', after('manager'))])),
    ).toEqual([]);
  });

  it('routes by step two waits on one topic that nothing orders', () => {
    expect(routedIds(plan([wait('a', 'approval'), wait('b', 'approval'), wait('c', 'legal')]))).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps waits on exclusive IF and SWITCH ports on the topic itself, and a join after them too', () => {
    const gate: DagNode = { kind: 'if', id: 'gate', condition: { left: true, op: 'truthy' }, guards: [] };
    const pick: DagNode = {
      kind: 'switch',
      id: 'pick',
      cases: [{ condition: { left: true, op: 'truthy' } }],
      guards: [],
    };
    expect(
      routedIds(
        plan([
          gate,
          wait('manager', 'signoff', after('gate', 0)),
          wait('director', 'signoff', after('gate', 1)),
          wait('final', 'signoff', [...after('manager'), ...after('director')]),
          pick,
          wait('first', 'pick', after('pick', 0)),
          wait('fallback', 'pick', after('pick', 1)),
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps waits on exclusive routes on the topic itself even when some of the routes merge again', () => {
    const size: DagNode = {
      kind: 'switch',
      id: 'size',
      cases: [{ condition: { left: true, op: 'truthy' } }, { condition: { left: true, op: 'truthy' } }],
      guards: [],
    };
    const auto: DagNode = { kind: 'code', id: 'auto', code: 'return 1;', guards: after('size', 0) };
    expect(
      routedIds(
        plan([
          size,
          auto,
          wait('manager', 'other', after('size', 1)),
          wait('final', 'approval', [...after('auto'), ...after('manager')]),
          wait('director', 'approval', after('size', 2)),
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps waits under nested IFs on the topic itself when a join merges some of their routes', () => {
    const g1: DagNode = { kind: 'if', id: 'g1', condition: { left: true, op: 'truthy' }, guards: [] };
    const g2: DagNode = {
      kind: 'if',
      id: 'g2',
      condition: { left: true, op: 'truthy' },
      guards: after('g1', 1),
    };
    expect(
      routedIds(
        plan([
          g1,
          g2,
          wait('a', 'other', after('g1', 0)),
          wait('b', 'other2', after('g2', 0)),
          wait('c', 'approval', after('g2', 1)),
          wait('j', 'approval', [...after('a'), ...after('b')]),
        ]),
      ),
    ).toEqual([]);
  });

  it('routes a wait on a merged route beside one on a route that runs with it', () => {
    const four: DagNode = {
      kind: 'switch',
      id: 'four',
      cases: [0, 1, 2].map(() => ({ condition: { left: true, op: 'truthy' as const } })),
      guards: [],
    };
    const tail: DagNode = { kind: 'code', id: 'tail', code: 'return 1;', guards: after('four', 3) };
    const nodes = [
      four,
      tail,
      wait('m', 'approval', [...after('four', 0), ...after('four', 1)]),
      wait('n', 'approval', after('four', 2)),
      wait('beside', 'approval', after('four', 1)),
      wait('last', 'approval', [...after('four', 2), ...after('tail')]),
    ];
    expect(routedIds(plan(nodes))).toEqual(['beside', 'last', 'm', 'n']);
  });

  it('routes waits in the two branches of a fork inside one route, and keeps the other route apart', () => {
    const gate: DagNode = { kind: 'if', id: 'gate', condition: { left: true, op: 'truthy' }, guards: [] };
    const fork: DagNode = {
      kind: 'parallel',
      id: 'fork',
      branches: [plan([wait('x', 'approval')]), plan([wait('y', 'approval')])],
      guards: after('gate', 0),
    };
    expect(routedIds(plan([gate, fork, wait('z', 'approval', after('gate', 1))]))).toEqual(['x', 'y']);
  });

  it('lists only the routers upstream of two waits, so routers elsewhere in the plan never make them concurrent', () => {
    const gate = (id: string, guards: Guard[] = []): DagNode => ({
      kind: 'if',
      id,
      condition: { left: true, op: 'truthy' },
      guards,
    });
    const roots = Array.from({ length: 13 }, (_, k) => gate(`g${k}`));
    expect(
      routedIds(
        plan([...roots, wait('yes', 'approval', after('g0', 0)), wait('no', 'approval', after('g0', 1))]),
      ),
    ).toEqual([]);

    const chain = [gate('g1', [...after('manager'), ...after('director')])];
    for (let k = 2; k <= 12; k++)
      chain.push(gate(`g${k}`, [...after(`g${k - 1}`, 0), ...after(`g${k - 1}`, 1)]));
    expect(
      routedIds(
        plan([
          gate('g0'),
          wait('manager', 'approval', after('g0', 0)),
          wait('director', 'approval', after('g0', 1)),
          ...chain,
          wait('final', 'approval', [...after('g12', 0), ...after('g12', 1)]),
        ]),
      ),
    ).toEqual([]);
  });

  it('routes two waits once the routers upstream of them have more outcomes than it lists', () => {
    const chain = (length: number): DagNode[] => {
      const gates: DagNode[] = [
        { kind: 'if', id: 'g0', condition: { left: true, op: 'truthy' }, guards: [] },
      ];
      for (let k = 1; k < length; k++) {
        gates.push({
          kind: 'if',
          id: `g${k}`,
          condition: { left: true, op: 'truthy' },
          guards: [...after(`g${k - 1}`, 0), ...after(`g${k - 1}`, 1)],
        });
      }
      const last = `g${length - 1}`;
      return [...gates, wait('yes', 'approval', after(last, 0)), wait('no', 'approval', after(last, 1))];
    };
    expect(routedIds(plan(chain(12)))).toEqual([]);
    expect(routedIds(plan(chain(13)))).toEqual(['no', 'yes']);
  });

  it('routes waits on the same IF port, which run together', () => {
    const gate: DagNode = { kind: 'if', id: 'gate', condition: { left: true, op: 'truthy' }, guards: [] };
    expect(
      routedIds(plan([gate, wait('a', 'signoff', after('gate', 0)), wait('b', 'signoff', after('gate', 0))])),
    ).toEqual(['a', 'b']);
  });

  it('routes waits in two parallel branches, and leaves one that waits for the fork to finish', () => {
    const fork: DagNode = {
      kind: 'parallel',
      id: 'fork',
      branches: [plan([wait('a1', 'approval')]), plan([wait('a2', 'approval')])],
      guards: [],
    };
    expect(routedIds(plan([fork, wait('final', 'approval', after('fork'))]))).toEqual(['a1', 'a2']);
  });

  it('keeps waits in one branch one after another on the topic itself', () => {
    const fork: DagNode = {
      kind: 'parallel',
      id: 'fork',
      branches: [
        plan([wait('a', 'approval'), wait('b', 'approval', after('a'))]),
        plan([wait('c', 'legal')]),
      ],
      guards: [],
    };
    expect(routedIds(plan([fork]))).toEqual([]);
  });

  it('keeps a loop’s single wait on the topic itself, since its rounds never overlap', () => {
    const loop = (id: string, body: DagNode[]): DagNode => ({
      kind: 'forEach',
      id,
      items: '{{trigger.items}}',
      itemVar: 'item',
      body: plan(body),
      guards: [],
    });
    expect(routedIds(plan([loop('each', [wait('approve', 'approval')])]))).toEqual([]);
    expect(routedIds(plan([loop('each', [wait('x', 'approval'), wait('y', 'approval')])]))).toEqual([
      'x',
      'y',
    ]);
    expect(routedIds(plan([loop('each', [wait('inner', 'approval')]), wait('outer', 'approval')]))).toEqual([
      'inner',
      'outer',
    ]);
  });

  it('routes an error lane’s wait beside a node it does not wait for, not one after its own step', () => {
    const risky: DagNode = {
      kind: 'action',
      id: 'risky',
      actionId: 'act.risky',
      props: {},
      guards: [],
      onErrorBranch: plan([wait('recover', 'legal')]),
    };
    expect(routedIds(plan([risky, wait('beside', 'legal')]))).toEqual(['beside', 'recover']);
    expect(routedIds(plan([risky, wait('later', 'legal', after('risky'))]))).toEqual([]);
  });
});

describe('isStepTopic / eventMessage', () => {
  it('knows a step’s own receive by its prefix', () => {
    expect(isStepTopic('orchestr:wait:fork|0/a')).toBe(true);
    expect(isStepTopic('approval')).toBe(false);
  });

  it('never sends a bare null, so a receive’s null means no event', () => {
    expect(eventMessage(null)).toBeUndefined();
    expect(eventMessage(undefined)).toBeUndefined();
    expect(eventMessage(false)).toBe(false);
    expect(eventMessage({ decision: 'approved' })).toEqual({ decision: 'approved' });
  });
});
