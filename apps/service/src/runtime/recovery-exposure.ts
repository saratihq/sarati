import type { RuntimeStepKind } from '../database/entities/runtime-run.entity';
import type { DagNode, DagPlan } from './dag-plan';
import { runTogether } from './event-wait';
import { PARK_DELAY_ABOVE_MS } from './timer-wait';

/** One durable op a run recorded. */
export interface RecordedOp {
  /** Its function name. */
  name: string;
  /** For an agent's model turn, the tool calls it asked for; `null` when its output can't be read. */
  toolCalls?: ReadonlyArray<{ id: string; name: string }> | null;
}

/** What a run recorded before it stopped, as the databases hold it. */
export interface RecordedRun {
  /** Its step rows, finished or not. */
  steps: ReadonlyArray<{ stepKey: string; kind: RuntimeStepKind; pinned: boolean }>;
  /** Its durable ops, in the order DBOS took them. */
  ops: readonly RecordedOp[];
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

/**
 * Whether a run the legacy engine started can resume on it: no step it recorded may have run beside another, since
 * that engine replays such steps in whatever order they come. Fails closed on anything it can't place exactly once.
 */
export function resumability(plan: DagPlan, run: RecordedRun): Resumability {
  const started: DagNode[] = [];
  const parks = { recv: 0, sleep: 0 };
  for (const step of run.steps) {
    if (step.pinned || ROUTING.has(step.kind)) continue;
    const found = placed(plan.nodes, '', step.stepKey, asStep);
    if (found.length !== 1) return notResumable(`step ${step.stepKey}`, found.length);
    started.push(found[0]!);
    explainParks(found[0]!, parks);
  }
  const recorded = { recv: 0, sleep: 0 };
  const prefix = `${plan.id}:`;
  const owners: Array<DagNode | undefined> = [];
  for (const { name } of run.ops) {
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
  const beside = besideAnother(plan);
  const exposed = started.find((node) => beside.has(node));
  if (exposed) {
    return {
      resumable: false,
      cause: 'side-by-side',
      reason: `node ${exposed.id} could run beside another step`,
    };
  }
  return refusedSubWorkflowCall(run.ops, owners) ?? { resumable: true };
}

// A sub-workflow call refused for the run's budget left no op, yet a replay makes it, since replayed children spend nothing.
function refusedSubWorkflowCall(
  ops: readonly RecordedOp[],
  owners: ReadonlyArray<DagNode | undefined>,
): Resumability | undefined {
  const names = ops.map((op) => op.name);
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
      if (names.includes(made)) {
        before.add(made);
      } else if (
        node.tools.find((tool) => tool.name === call.name)?.kind === 'workflow' &&
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
function besideAnother(plan: DagPlan, inherited = false, out = new Set<DagNode>()): Set<DagNode> {
  const working = plan.nodes.flatMap((node, i) => (bearsWork(node) ? [i] : []));
  const pairs = working.flatMap((a, k) => working.slice(k + 1).map((b): [number, number] => [a, b]));
  const together = new Set(runTogether(plan, pairs).flat());
  plan.nodes.forEach((node, i) => {
    const beside = inherited || together.has(i);
    if (beside) out.add(node);
    for (const [child, under] of childPlans(node, beside)) besideAnother(child, under, out);
  });
  return out;
}

function childPlans(node: DagNode, beside: boolean): Array<[DagPlan, boolean]> {
  if (node.kind === 'parallel') {
    const fannedOut = node.branches.filter((branch) => branch.nodes.some(bearsWork)).length > 1;
    return node.branches.map((branch) => [branch, beside || fannedOut]);
  }
  if (node.kind === 'forEach' || node.kind === 'while') return [[node.body, beside]];
  return 'onErrorBranch' in node && node.onErrorBranch ? [[node.onErrorBranch, beside]] : [];
}

function bearsWork(node: DagNode): boolean {
  switch (node.kind) {
    case 'if':
    case 'switch':
      return false;
    case 'parallel':
      return node.branches.some((branch) => branch.nodes.some(bearsWork));
    case 'forEach':
    case 'while':
      return node.body.nodes.some(bearsWork);
    default:
      return true;
  }
}
