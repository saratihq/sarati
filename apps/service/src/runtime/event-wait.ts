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
interface InPlanGuard {
  source: number;
  port: number;
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
    const together = runTogether(plan);
    sharing
      .filter(([i, j]) => together(i, j))
      .forEach(([i, j]) => markShared([waits[i]!, waits[j]!], routed));
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

function pairs(xs: number[]): Array<[number, number]> {
  return xs.flatMap((a, k) => xs.slice(k + 1).map((b): [number, number] => [a, b]));
}

// Waits on one topic in two different groups can be parked together.
function markShared(groups: Waits[], routed: Set<DagWaitForEventNode>): void {
  for (const [i, j] of pairs(groups.map((_, k) => k))) {
    const other = groups[j]!;
    const both = [...groups[i]!].filter(([topic]) => other.has(topic));
    both.forEach(([topic, nodes]) => [...nodes, ...other.get(topic)!].forEach((n) => routed.add(n)));
  }
}

// Two nodes of one plan run at once when neither waits on the other and some outcome of the routers upstream of them runs both.
function runTogether(plan: DagPlan): (i: number, j: number) => boolean {
  const guards = inPlanGuards(plan);
  const before = ancestorsOf(guards);
  return (i, j) =>
    !before[j]!.has(i) &&
    !before[i]!.has(j) &&
    liveTogether(plan, guards, new Set([...before[i]!, ...before[j]!]), i, j);
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

// Only routers upstream of i or j decide whether they run, so only their outcomes are listed.
function liveTogether(
  plan: DagPlan,
  guards: InPlanGuard[][],
  upstream: Set<number>,
  i: number,
  j: number,
): boolean {
  const outcomes = routerOutcomes(plan, upstream);
  if (!outcomes) return true;
  return outcomes.some((outcome) => {
    const live = liveUnder(plan, guards, outcome);
    return live[i]! && live[j]!;
  });
}

// Every combination of ports the IF/SWITCH nodes `among` can take, or null when there are too many to list.
function routerOutcomes(plan: DagPlan, among: Set<number>): Array<Map<number, number>> | null {
  const routers = [...among].flatMap((i): Array<[number, number]> => {
    const n = plan.nodes[i]!;
    if (n.kind === 'if') return [[i, 2]];
    return n.kind === 'switch' ? [[i, n.cases.length + 1]] : [];
  });
  if (routers.reduce((total, [, ports]) => total * ports, 1) > MAX_ROUTER_OUTCOMES) return null;
  return routers.reduce<Array<Map<number, number>>>(
    (outcomes, [router, ports]) =>
      outcomes.flatMap((o) => Array.from({ length: ports }, (_, port) => new Map(o).set(router, port))),
    [new Map<number, number>()],
  );
}

// As the scheduler runs a node: a root, or any guard whose source ran with that port live.
function liveUnder(plan: DagPlan, guards: InPlanGuard[][], outcome: Map<number, number>): boolean[] {
  const live: boolean[] = [];
  plan.nodes.forEach((node, i) => {
    live[i] =
      node.guards.length === 0 ||
      guards[i]!.some((g) => live[g.source]! && (outcome.get(g.source) ?? g.port) === g.port);
  });
  return live;
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
