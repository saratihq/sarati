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

const truthy = { left: true, op: 'truthy' } as const;
const gate = (id: string, guards: Guard[] = []): DagNode => ({ kind: 'if', id, condition: truthy, guards });
const fan = (id: string, cases: number, guards: Guard[] = []): DagNode => ({
  kind: 'switch',
  id,
  cases: Array.from({ length: cases }, () => ({ condition: truthy })),
  guards,
});
const ports = (n: DagNode): number => {
  if (n.kind === 'if') return 2;
  return n.kind === 'switch' ? n.cases.length + 1 : 1;
};
const nested = (n: DagNode): DagPlan[] => {
  if (n.kind === 'forEach' || n.kind === 'while') return [n.body];
  if (n.kind === 'parallel') return n.branches;
  return 'onErrorBranch' in n && n.onErrorBranch ? [n.onErrorBranch] : [];
};

// The frozen rule stated plainly and slowly: every assignment of the routers upstream of a pair, and liveness by recursion.
function referenceRouted(p: DagPlan, routed = new Set<string>()): Set<string> {
  const index = new Map(p.nodes.map((n, k) => [n.id, k]));
  const sources = (k: number): Array<{ s: number; port: number }> =>
    p.nodes[k]!.guards.flatMap((g) => {
      const s = index.get(g.source);
      return s !== undefined && s < k ? [{ s, port: g.port }] : [];
    });
  const upstream = (k: number): number[] => sources(k).flatMap(({ s }) => [s, ...upstream(s)]);
  const runs = (k: number, outcome: Map<number, number>): boolean =>
    p.nodes[k]!.guards.length === 0 ||
    sources(k).some(({ s, port }) => runs(s, outcome) && (outcome.get(s) ?? port) === port);
  const waitsOf = (nodes: DagNode[]): Array<[string, string]> =>
    nodes.flatMap((n) => [
      ...(n.kind === 'waitForEvent' ? [[n.topic, n.id] as [string, string]] : []),
      ...nested(n).flatMap((c) => waitsOf(c.nodes)),
    ]);
  const share = (a: Array<[string, string]>, b: Array<[string, string]>): void => {
    for (const [ta, ia] of a) {
      for (const [tb, ib] of b) {
        if (ta === tb) routed.add(ia).add(ib);
      }
    }
  };
  p.nodes.forEach((_, i) => {
    for (let j = i + 1; j < p.nodes.length; j++) {
      if (upstream(j).includes(i)) continue;
      const routers = [...new Set([...upstream(i), ...upstream(j)])].filter((k) => ports(p.nodes[k]!) > 1);
      const count = routers.reduce((total, k) => total * ports(p.nodes[k]!), 1);
      const outcomes = routers.reduce<Array<Map<number, number>>>(
        (all, k) =>
          all.flatMap((o) =>
            Array.from({ length: ports(p.nodes[k]!) }, (_, port) => new Map(o).set(k, port)),
          ),
        [new Map()],
      );
      if (count > 4096 || outcomes.some((o) => runs(i, o) && runs(j, o))) {
        share(waitsOf([p.nodes[i]!]), waitsOf([p.nodes[j]!]));
      }
    }
  });
  for (const n of p.nodes) {
    if (n.kind === 'parallel') {
      n.branches.forEach((a, k) =>
        n.branches.slice(k + 1).forEach((b) => share(waitsOf(a.nodes), waitsOf(b.nodes))),
      );
    }
    nested(n).forEach((c) => referenceRouted(c, routed));
  }
  return routed;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// A random plan: routers, waits on few topics, joins, guards on random earlier ports, and nested loops, forks and error lanes.
function randomPlan(
  rand: () => number,
  depth: number,
  size: number,
  routers: number,
  ids = { next: 0 },
): DagPlan {
  const nodes: DagNode[] = [];
  const guardsFor = (k: number): Guard[] =>
    k === 0 || rand() < 0.15
      ? []
      : Array.from({ length: 1 + Math.floor(rand() * 2) }, () => {
          const source = nodes[Math.floor(rand() * k)]!;
          return { source: source.id, port: Math.floor(rand() * ports(source)) };
        });
  for (let k = 0; k < size; k++) {
    const id = `n${ids.next++}`;
    const guards = guardsFor(k);
    const roll = rand();
    const child = (): DagPlan => randomPlan(rand, depth - 1, 1 + Math.floor(rand() * 3), routers, ids);
    if (k < routers)
      nodes.push(rand() < 0.6 ? gate(id, guards) : fan(id, 1 + Math.floor(rand() * 4), guards));
    else if (roll < 0.6) nodes.push(wait(id, rand() < 0.7 ? 'a' : 'b', guards));
    else if (depth > 0 && roll < 0.7)
      nodes.push({ kind: 'parallel', id, branches: [child(), child()], guards });
    else if (depth > 0 && roll < 0.8)
      nodes.push({ kind: 'forEach', id, items: '{{x}}', itemVar: 'i', body: child(), guards });
    else if (depth > 0 && roll < 0.9)
      nodes.push({ kind: 'code', id, code: '1', guards, onErrorBranch: child() });
    else nodes.push({ kind: 'code', id, code: '1', guards });
  }
  return plan(nodes);
}

describe('waitsRoutedByStep against the frozen rule', () => {
  it('answers exactly as the rule on random plans, past the cap included', () => {
    const rand = seeded(20261012);
    for (let k = 0; k < 1500; k++) {
      const p = randomPlan(rand, k % 3, 6 + Math.floor(rand() * 12), Math.floor(rand() * (k % 2 ? 14 : 5)));
      expect(routedIds(p)).toEqual([...referenceRouted(p)].sort());
    }
  });

  it('answers each pair by its own routers, whichever pair behind as many routers is listed first', () => {
    expect(
      routedIds(
        plan([
          gate('g1'),
          gate('g2'),
          wait('c', 'legal', after('g2', 0)),
          wait('d', 'legal', after('g2', 0)),
          wait('a', 'approval', after('g1', 0)),
          wait('b', 'approval', after('g1', 1)),
        ]),
      ),
    ).toEqual(['c', 'd']);
  });

  it.each<[string, () => DagNode[], number]>([
    [
      '50 approvals on one topic over 12 chained IFs',
      () => [
        ...Array.from({ length: 12 }, (_, k) =>
          gate(`g${k}`, k ? [...after(`g${k - 1}`, 0), ...after(`g${k - 1}`, 1)] : []),
        ),
        ...Array.from({ length: 50 }, (_, k) =>
          wait(`w${k}`, 'approval', after(`g${k % 12}`, Math.floor(k / 12) % 2)),
        ),
      ],
      50,
    ],
    [
      '50 approvals on one topic, each behind a random half of 12 IFs',
      () => {
        const rand = seeded(7);
        return [
          ...Array.from({ length: 12 }, (_, k) => gate(`g${k}`)),
          ...Array.from({ length: 50 }, (_, k) =>
            wait(
              `w${k}`,
              'approval',
              Array.from({ length: 12 }, (_, m) => m)
                .filter(() => rand() < 0.5)
                .map((m) => ({ source: `g${m}`, port: rand() < 0.5 ? 0 : 1 })),
            ),
          ),
        ];
      },
      50,
    ],
    [
      'an approval on each port of a 32-way Switch behind 7 IFs',
      () => [
        ...Array.from({ length: 7 }, (_, k) =>
          gate(`g${k}`, k ? [...after(`g${k - 1}`, 0), ...after(`g${k - 1}`, 1)] : []),
        ),
        fan('s', 31, [...after('g6', 0), ...after('g6', 1)]),
        ...Array.from({ length: 32 }, (_, k) => wait(`w${k}`, 'approval', after('s', k))),
      ],
      0,
    ],
    [
      'an approval on each port of a 128-way Switch behind 5 IFs, then 300 steps',
      () => [
        ...Array.from({ length: 5 }, (_, k) =>
          gate(`g${k}`, k ? [...after(`g${k - 1}`, 0), ...after(`g${k - 1}`, 1)] : []),
        ),
        fan('s', 127, [...after('g4', 0), ...after('g4', 1)]),
        ...Array.from({ length: 128 }, (_, k) => wait(`w${k}`, 'approval', after('s', k))),
        ...Array.from({ length: 300 }, (_, k): DagNode => ({
          kind: 'code',
          id: `c${k}`,
          code: '1',
          guards: k ? after(`c${k - 1}`) : [],
        })),
      ],
      0,
    ],
    [
      'an approval on each leaf of a 10 by 10 Switch tree',
      () => [
        fan('top', 9),
        ...Array.from({ length: 10 }, (_, a) => fan(`s${a}`, 9, after('top', a))),
        ...Array.from({ length: 100 }, (_, k) =>
          wait(`w${k}`, 'approval', after(`s${Math.floor(k / 10)}`, k % 10)),
        ),
      ],
      0,
    ],
  ])('answers %s within 200 ms of CPU', (_, nodes, routed) => {
    const p = plan(nodes());
    const before = process.cpuUsage();
    const answer = waitsRoutedByStep(p);
    const { user, system } = process.cpuUsage(before);
    expect((user + system) / 1000).toBeLessThan(200);
    expect(answer.size).toBe(routed);
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
