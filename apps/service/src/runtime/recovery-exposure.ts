import type { RuntimeStepKind } from '../database/entities/runtime-run.entity';
import { leafScopeValue, MAX_SUB_WORKFLOW_INVOCATIONS } from './base-plan-interpreter';
import { routedPort } from './conditions';
import type { DagNode, DagPlan } from './dag-plan';
import { planAncestors, runTogether } from './event-wait';
import { PARK_DELAY_ABOVE_MS } from './timer-wait';

/** One durable op a run recorded. */
export interface RecordedOp {
  /** Its function name. */
  name: string;
  /** What it returned, decoded as a replay decodes it; absent when it was not read. */
  output?: unknown;
  /** Whether it recorded an error rather than an output. */
  failed?: boolean;
  /** For an agent's model turn, the tool calls it asked for; `null` when its output can't be read. */
  toolCalls?: ReadonlyArray<{ id: string; name: string }> | null;
}

/** One step row a run recorded. */
export interface RecordedStep {
  stepKey: string;
  kind: RuntimeStepKind;
  pinned: boolean;
}

/** What a legacy run checkpointed to start from: its plan, its pins and the scope it began with. */
export interface CheckpointedRun {
  plan: DagPlan;
  pins: Readonly<Record<string, unknown>>;
  initialScope: Readonly<Record<string, unknown>>;
}

/** An agent's model-turn op name, `<plan id>:<step key>#<round>:model`, whose output names the tool calls it asked for. */
export const MODEL_TURN = /#\d+:model$/;

/** Whether a stopped run can resume on the legacy engine; when not, the first thing that rules it out. */
export type Resumability =
  { resumable: true } | { resumable: false; cause: NotResumableCause; reason: string };

/** Why a stopped run can't resume: steps that ran side by side, a sub-workflow call an agent was refused, or a history that can't be matched to its plan. */
export type NotResumableCause = 'side-by-side' | 'refused-call' | 'unmatched';

const RECV = 'DBOS.recv';
const SLEEP = 'DBOS.sleep';
const ROUTING: ReadonlySet<RuntimeStepKind> = new Set(['if', 'switch']);
const LEAVES: ReadonlySet<DagNode['kind']> = new Set(['action', 'code', 'agent', 'callWorkflow']);

type Match = (node: DagNode, key: string, wanted: string) => boolean;

const asStep: Match = (_node, key, wanted) => key === wanted;

const asOp: Match = (node, key, wanted) => {
  if (node.kind === 'agent') {
    return (
      wanted === `${key}#final:model` ||
      (wanted.startsWith(`${key}#`) && /^\d+:(model|tool:.+)$/s.test(wanted.slice(key.length + 1)))
    );
  }
  return wanted === key && (node.kind === 'action' || node.kind === 'code' || node.kind === 'callWorkflow');
};

/** The recovery guard's one verdict on a legacy run, from what it checkpointed, its ops and its step rows (`null` with no run row). */
export function verdict(
  run: CheckpointedRun,
  ops: readonly RecordedOp[],
  steps: readonly RecordedStep[] | null,
  budget = MAX_SUB_WORKFLOW_INVOCATIONS,
): Resumability {
  if (ops.length === 0) return { resumable: true };
  if (!steps) return { resumable: false, cause: 'unmatched', reason: 'it has no run row' };
  const { plan } = run;
  const pins = new Set(Object.keys(run.pins));
  const started: DagNode[] = [];
  const parks = { recv: 0, sleep: 0 };
  for (const step of steps) {
    if (step.pinned || ROUTING.has(step.kind)) continue;
    const found = placed(plan.nodes, '', step.stepKey, asStep);
    if (found.length !== 1) return notResumable(`step ${step.stepKey}`, found.length);
    started.push(found[0]!);
    explainParks(found[0]!, parks);
  }
  const recorded = { recv: 0, sleep: 0 };
  const prefix = `${plan.id}:`;
  const owners: Array<DagNode | undefined> = [];
  for (const { name } of ops) {
    if (name === RECV || name === SLEEP) {
      recorded[name === RECV ? 'recv' : 'sleep'] += 1;
      owners.push(undefined);
      continue;
    }
    const found = name.startsWith(prefix) ? placed(plan.nodes, '', name.slice(prefix.length), asOp) : [];
    if (found.length !== 1) return notResumable(`op ${name}`, found.length);
    started.push(found[0]!);
    owners.push(found[0]);
  }
  if (recorded.recv > parks.recv || recorded.sleep > parks.sleep) {
    return {
      resumable: false,
      cause: 'unmatched',
      reason: 'it recorded a receive or a sleep no started wait or delay explains',
    };
  }
  const beside = besideAnother(plan, pins, takenPorts(run, ops));
  const exposed = started.find((node) => beside.has(node));
  if (exposed) {
    return {
      resumable: false,
      cause: 'side-by-side',
      reason: `node ${exposed.id} could run beside another step`,
    };
  }
  return refusedSubWorkflowCall(ops, owners, budget) ?? { resumable: true };
}

/** The port each top-level router takes when the run is replayed, by its id, where the replay's view of what it reads is known. */
export function replayRoutes(run: CheckpointedRun, ops: readonly RecordedOp[]): ReadonlyMap<string, number> {
  const taken = takenPorts(run, ops);
  return new Map([...taken].map(([i, port]) => [run.plan.nodes[i]!.id, port]));
}

// A node's replayed scope entry: `known` once the replay's value is certain, `undefined` for a node routed away.
type Entry = { known: true; value: unknown } | { known: false };

// Each top-level router's port, over the scope a replay rebuilds: each ancestor's recorded op output as the interpreter
// hands it to scope, a live leaf's pin, `undefined` for one routed away. A router reading anything else is judged on every port.
function takenPorts(run: CheckpointedRun, ops: readonly RecordedOp[]): Map<number, number> {
  const { plan } = run;
  const recorded = new Map(ops.map((op) => [op.name, op]));
  const index = new Map(plan.nodes.map((node, i) => [node.id, i]));
  const ancestors = planAncestors(plan);
  const ran: Array<boolean | undefined> = [];
  const entries: Entry[] = [];
  const taken = new Map<number, number>();
  plan.nodes.forEach((node, i) => {
    const live = liveness(plan, node, index, ran, taken);
    ran[i] = live;
    if (live !== true) {
      entries[i] = live === false ? { known: true, value: undefined } : { known: false };
      return;
    }
    if (node.kind !== 'if' && node.kind !== 'switch') {
      entries[i] = leafEntry(run, node, recorded);
      return;
    }
    entries[i] = { known: false };
    const scope: Record<string, unknown> = { ...run.initialScope };
    for (const a of ancestors[i]!) {
      const entry = entries[a]!;
      if (entry.known) scope[plan.nodes[a]!.id] = entry.value;
    }
    try {
      taken.set(i, routedPort(node, scope));
    } catch {
      // A reference to a step whose replayed value isn't known here: the interpreter would read the replay's.
    }
  });
  return taken;
}

// Whether the replay runs `node`, as the interpreter's guards decide it: `undefined` while a source's route is unknown.
function liveness(
  plan: DagPlan,
  node: DagNode,
  index: ReadonlyMap<string, number>,
  ran: ReadonlyArray<boolean | undefined>,
  taken: ReadonlyMap<number, number>,
): boolean | undefined {
  if (node.guards.length === 0) return true;
  let unknown = false;
  for (const guard of node.guards) {
    const source = index.get(guard.source);
    if (source === undefined || ran[source] === false) continue;
    const kind = plan.nodes[source]!.kind;
    const port = kind === 'if' || kind === 'switch' ? taken.get(source) : guard.port;
    if (ran[source] === undefined || port === undefined) unknown = true;
    else if (port === guard.port) return true;
  }
  return unknown ? undefined : false;
}

// A live node's scope entry as the replay rebuilds it: a leaf's pin, or the output its one op recorded; nothing else is known.
function leafEntry(run: CheckpointedRun, node: DagNode, recorded: ReadonlyMap<string, RecordedOp>): Entry {
  if (!LEAVES.has(node.kind)) return { known: false };
  if (Object.prototype.hasOwnProperty.call(run.pins, node.id))
    return { known: true, value: run.pins[node.id] };
  if (node.kind !== 'action' && node.kind !== 'code' && node.kind !== 'callWorkflow') return { known: false };
  const op = recorded.get(`${run.plan.id}:${node.id}`);
  if (!op || op.failed || !('output' in op)) return { known: false };
  return { known: true, value: leafScopeValue(node.kind, op.output) };
}

// A refused call left no op; its replay refuses it too while the run's own agents spent the budget, as they spend it again.
function refusedSubWorkflowCall(
  ops: readonly RecordedOp[],
  owners: ReadonlyArray<DagNode | undefined>,
  budget: number,
): Resumability | undefined {
  const names = ops.map((op) => op.name);
  let spent = 0;
  for (const [i, op] of ops.entries()) {
    const node = owners[i];
    if (node?.kind !== 'agent' || !MODEL_TURN.test(op.name)) continue;
    if (!node.tools.some((tool) => tool.kind === 'workflow')) continue;
    if (!op.toolCalls) {
      return {
        resumable: false,
        cause: 'unmatched',
        reason: `node ${node.id} recorded a model turn whose tool calls can't be read`,
      };
    }
    const round = op.name.slice(0, -':model'.length);
    const before = new Set<string>();
    for (const call of op.toolCalls) {
      const made = `${round}:tool:${call.id}`;
      const callsWorkflow = node.tools.find((tool) => tool.name === call.name)?.kind === 'workflow';
      if (names.includes(made)) {
        before.add(made);
        if (callsWorkflow) spent += 1;
      } else if (
        callsWorkflow &&
        budget - spent > 0 &&
        names.slice(i + 1).some((name) => !before.has(name))
      ) {
        return {
          resumable: false,
          cause: 'refused-call',
          reason: `node ${node.id} was refused a sub-workflow call that a replay could make`,
        };
      }
    }
  }
  return undefined;
}

function notResumable(what: string, matches: number): Resumability {
  return {
    resumable: false,
    cause: 'unmatched',
    reason: `${what} ${matches === 0 ? 'matches no node of its plan' : `matches ${matches} nodes of its plan`}`,
  };
}

// Every node whose instance key, under the step keys the interpreter builds, is `wanted`.
function placed(
  nodes: readonly DagNode[],
  path: string,
  wanted: string,
  match: Match,
  out: DagNode[] = [],
): DagNode[] {
  for (const node of nodes) {
    const key = `${path}${node.id}`;
    if (match(node, key, wanted)) out.push(node);
    if (node.kind === 'parallel') {
      node.branches.forEach((branch, i) => {
        const prefix = `${key}|${i}/`;
        if (wanted.startsWith(prefix)) placed(branch.nodes, prefix, wanted, match, out);
      });
    }
    if ((node.kind === 'forEach' || node.kind === 'while') && wanted.startsWith(`${key}#`)) {
      const round = /^(\d+)\//.exec(wanted.slice(key.length + 1));
      if (round) placed(node.body.nodes, `${key}#${round[1]}/`, wanted, match, out);
    }
    // The legacy engine runs an error lane under its source's own path.
    if ('onErrorBranch' in node && node.onErrorBranch)
      placed(node.onErrorBranch.nodes, path, wanted, match, out);
  }
  return out;
}

// The receives and sleeps one started wait or delay accounts for: its own, and its receive's timeout.
function explainParks(node: DagNode, parks: { recv: number; sleep: number }): void {
  if (node.kind === 'waitForEvent' || (node.kind === 'delay' && node.ms > PARK_DELAY_ABOVE_MS)) {
    parks.recv += 1;
    parks.sleep += 1;
  } else if (node.kind === 'delay') {
    parks.sleep += 1;
  }
}

// Every node that can have work in flight beside another's: within its own plan, inside a fan-out, or under one.
function besideAnother(
  plan: DagPlan,
  pins: ReadonlySet<string>,
  taken: ReadonlyMap<number, number> = new Map(),
  inherited = false,
  out = new Set<DagNode>(),
): Set<DagNode> {
  const working = plan.nodes.flatMap((node, i) => (bearsWork(node, pins) ? [i] : []));
  const pairs = working.flatMap((a, k) => working.slice(k + 1).map((b): [number, number] => [a, b]));
  const together = new Set(runTogether(plan, pairs, taken).flat());
  plan.nodes.forEach((node, i) => {
    const beside = inherited || together.has(i);
    if (beside) out.add(node);
    for (const [child, under] of childPlans(node, beside, pins))
      besideAnother(child, pins, new Map(), under, out);
  });
  return out;
}

function childPlans(node: DagNode, beside: boolean, pins: ReadonlySet<string>): Array<[DagPlan, boolean]> {
  if (node.kind === 'parallel') {
    const fannedOut =
      node.branches.filter((branch) => branch.nodes.some((n) => bearsWork(n, pins))).length > 1;
    return node.branches.map((branch) => [branch, beside || fannedOut]);
  }
  if (node.kind === 'forEach' || node.kind === 'while') return [[node.body, beside]];
  return 'onErrorBranch' in node && node.onErrorBranch ? [[node.onErrorBranch, beside]] : [];
}

// A pinned leaf replays its pin and issues no op, so it has nothing to be misordered with.
function bearsWork(node: DagNode, pins: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'if':
    case 'switch':
      return false;
    case 'parallel':
      return node.branches.some((branch) => branch.nodes.some((n) => bearsWork(n, pins)));
    case 'forEach':
    case 'while':
      return node.body.nodes.some((n) => bearsWork(n, pins));
    default:
      return !(LEAVES.has(node.kind) && pins.has(node.id));
  }
}
