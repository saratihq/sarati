import type { DagNode, DagPlan, DagWaitForEventNode } from './dag-plan';

/** The prefix of a step's own receive, which no authored wait may use. */
export const EVENT_TOPIC_PREFIX = 'orchestr:wait:';
// Past this many outcomes of the IF/SWITCH nodes upstream of either of two unordered waits, they count as able to run at once.
const MAX_ROUTER_OUTCOMES = 4096;

/** The DBOS topic a wait-for-event step receives on when another wait could share its topic's — its own. */
export function eventTopicFor(stepKey: string): string {
  return `${EVENT_TOPIC_PREFIX}${stepKey}`;
}

/** Whether `topic` is spelled like a step's own receive, which no authored wait may use. */
export function isStepTopic(topic: string): boolean {
  return topic.startsWith(EVENT_TOPIC_PREFIX);
}

/** An event with no payload travels as `undefined`, so a receive's `null` always means no event arrived. */
export function eventMessage(payload: unknown): unknown {
  return payload ?? undefined;
}

type Waits = Map<string, DagWaitForEventNode[]>;
type Pair = [number, number];
// A router's index in its plan, and how many ports it has.
type Routers = Map<number, number>;
interface InPlanGuard {
  source: number;
  port: number;
}
interface Bin {
  routers: Routers;
  pairs: Pair[];
}

/** Waits another wait on their topic can be parked beside; frozen for runs carrying `sharedTopicsByStep` (a change needs a new arg). */
export function waitsRoutedByStep(plan: DagPlan): ReadonlySet<DagWaitForEventNode> {
  const routed = new Set<DagWaitForEventNode>();
  scan(plan, routed);
  return routed;
}

function scan(plan: DagPlan, routed: Set<DagWaitForEventNode>): void {
  const waits = plan.nodes.map((n) => waitsIn([n]));
  const holding = waits.flatMap((w, i) => (w.size > 0 ? [i] : []));
  const sharing = pairs(holding).filter(([i, j]) => [...waits[i]!.keys()].some((t) => waits[j]!.has(t)));
  if (sharing.length > 0) {
    runTogether(plan, sharing).forEach(([i, j]) => markShared([waits[i]!, waits[j]!], routed));
  }
  for (const node of plan.nodes) {
    if (node.kind === 'parallel')
      markShared(
        node.branches.map((b) => waitsIn(b.nodes)),
        routed,
      );
    childPlans(node).forEach((child) => scan(child, routed));
  }
}

function pairs(xs: number[]): Pair[] {
  return xs.flatMap((a, k) => xs.slice(k + 1).map((b): Pair => [a, b]));
}

// Waits on one topic in two different groups can be parked together.
function markShared(groups: Waits[], routed: Set<DagWaitForEventNode>): void {
  for (const [i, j] of pairs(groups.map((_, k) => k))) {
    const other = groups[j]!;
    const both = [...groups[i]!].filter(([topic]) => other.has(topic));
    both.forEach(([topic, nodes]) => [...nodes, ...other.get(topic)!].forEach((n) => routed.add(n)));
  }
}

/** The pairs of `plan.nodes` indexes in `sharing` that can run at once: neither waits on the other, and some router outcome runs both. */
export function runTogether(
  plan: DagPlan,
  sharing: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const guards = inPlanGuards(plan);
  const before = ancestorsOf(guards);
  const together: Pair[] = [];
  const bins = new Map<string, Bin>();
  for (const [i, j] of sharing) {
    if (before[j]!.has(i) || before[i]!.has(j)) continue;
    const routers = routersAmong(plan, [...before[i]!, ...before[j]!]);
    if (outcomeCount(routers) > MAX_ROUTER_OUTCOMES) together.push([i, j]);
    else binOf(bins, routers).pairs.push([i, j]);
  }
  return [...together, ...[...bins.values()].flatMap((bin) => liveTogether(plan, guards, before, bin))];
}

// A guard counts only when its source sits earlier in this plan; any other source never runs here.
function inPlanGuards(plan: DagPlan): InPlanGuard[][] {
  const index = new Map(plan.nodes.map((n, i) => [n.id, i]));
  return plan.nodes.map((node, i) =>
    node.guards.flatMap((g) => {
      const source = index.get(g.source);
      return source !== undefined && source < i ? [{ source, port: g.port }] : [];
    }),
  );
}

function ancestorsOf(guards: InPlanGuard[][]): Array<Set<number>> {
  const before: Array<Set<number>> = [];
  guards.forEach((own, i) => {
    before[i] = new Set(own.flatMap((g) => [g.source, ...before[g.source]!]));
  });
  return before;
}

function routersAmong(plan: DagPlan, among: number[]): Routers {
  return new Map(
    among.flatMap((i): Pair[] => {
      const n = plan.nodes[i]!;
      if (n.kind === 'if') return [[i, 2]];
      return n.kind === 'switch' ? [[i, n.cases.length + 1]] : [];
    }),
  );
}

function outcomeCount(routers: Routers): number {
  return [...routers.values()].reduce((total, ports) => total * ports, 1);
}

// Pairs behind the same routers share one listing of their outcomes.
function binOf(bins: Map<string, Bin>, routers: Routers): Bin {
  const key = [...routers.keys()].sort((a, b) => a - b).join(',');
  const bin = bins.get(key) ?? { routers, pairs: [] };
  bins.set(key, bin);
  return bin;
}

// Each node marks the outcomes it runs under; a pair runs together when their marks overlap.
function liveTogether(plan: DagPlan, guards: InPlanGuard[][], before: Array<Set<number>>, bin: Bin): Pair[] {
  const holders = [...new Set(bin.pairs.flat())];
  const needed = [...new Set(holders.flatMap((h) => [...before[h]!, h]))].sort((a, b) => a - b);
  const words = Math.ceil(outcomeCount(bin.routers) / 32);
  const runs = new Map(holders.map((h) => [h, new Uint32Array(words)]));
  const live = new Uint8Array(plan.nodes.length);
  let outcome = 0;
  eachOutcome(plan.nodes.length, bin.routers, (port) => {
    markLive(plan, guards, port, needed, live);
    runs.forEach((marks, h) => {
      if (live[h]) marks[outcome >> 5]! |= 1 << (outcome & 31);
    });
    outcome++;
  });
  return bin.pairs.filter(([i, j]) => runs.get(i)!.some((word, k) => (word & runs.get(j)![k]!) !== 0));
}

// Visits each combination of ports the routers can take, -1 standing for a node that is not one of them.
function eachOutcome(size: number, routers: Routers, visit: (port: Int32Array) => void): void {
  const port = new Int32Array(size).fill(-1);
  const digits = [...routers];
  digits.forEach(([router]) => (port[router] = 0));
  do visit(port);
  while (advance(port, digits));
}

function advance(port: Int32Array, digits: Pair[]): boolean {
  for (const [router, ports] of digits) {
    port[router] = (port[router]! + 1) % ports;
    if (port[router] !== 0) return true;
  }
  return false;
}

// As the scheduler runs a node: a root, or any guard whose source ran with that port live; `nodes` holds every source it reads.
function markLive(
  plan: DagPlan,
  guards: InPlanGuard[][],
  port: Int32Array,
  nodes: number[],
  live: Uint8Array,
): void {
  for (const i of nodes) {
    const own = guards[i]!;
    let on = plan.nodes[i]!.guards.length === 0;
    for (let k = 0; !on && k < own.length; k++) {
      const { source, port: wanted } = own[k]!;
      on = live[source] === 1 && (port[source] === -1 || port[source] === wanted);
    }
    live[i] = on ? 1 : 0;
  }
}

function waitsIn(nodes: DagNode[], found: Waits = new Map()): Waits {
  for (const n of nodes) {
    if (n.kind === 'waitForEvent') found.set(n.topic, [...(found.get(n.topic) ?? []), n]);
    childPlans(n).forEach((child) => waitsIn(child.nodes, found));
  }
  return found;
}

function childPlans(node: DagNode): DagPlan[] {
  if (node.kind === 'forEach' || node.kind === 'while') return [node.body];
  if (node.kind === 'parallel') return node.branches;
  return 'onErrorBranch' in node && node.onErrorBranch ? [node.onErrorBranch] : [];
}
