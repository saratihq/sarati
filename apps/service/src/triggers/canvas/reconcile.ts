import { isTriggerNode } from '../../compiler/compile-ir';
import type { IRNode, WorkflowIR } from '../../ir/models';
import {
  activationDescriptorEqual,
  activationKeyString,
  type ActivationKind,
  type ActualActivation,
  type ConnectionRef,
  type DesiredActivation,
} from './trigger-activation';

/**
 * The pure core of the trigger reconciler — no DB, no provider calls, no DI:
 * `deriveDesiredActivations` (env pointers × version-doc trigger nodes) → DESIRED, and
 * `reconcileActivations` (DESIRED, ACTUAL) → the create/update/delete plan the applier runs.
 */

/** One env pointer's contribution to the desired set: which version answers, in which env. */
export interface EnvPointerInput {
  environmentId: string;
  versionId: string;
  ir: WorkflowIR;
}

/** Resolve the account for a trigger node under an env (the env slot; `null` when none needed). */
export type ConnectionResolver = (environmentId: string, triggerNode: IRNode) => ConnectionRef | null;

/** Classify a trigger node into an activation kind; `null` = no runtime activation (manual). */
export type KindResolver = (triggerNode: IRNode) => ActivationKind | null;

/** Whether a trigger node is currently paused by an operator override (default: not paused). */
export type PauseResolver = (environmentId: string, triggerNode: IRNode) => boolean;

export interface DeriveInput {
  workflowId: string;
  pointers: EnvPointerInput[];
  kindOf: KindResolver;
  connectionOf: ConnectionResolver;
  pausedOf?: PauseResolver;
}

/**
 * DESIRED = ⋃ over env pointers of the trigger nodes in each pointed version, keyed by
 * `(workflow, env, node id)`. The trigger predicate is the compiler's `isTriggerNode` — the
 * SINGLE definition of "which nodes are triggers" (vault); never fork it here.
 */
export function deriveDesiredActivations(input: DeriveInput): DesiredActivation[] {
  const pausedOf = input.pausedOf ?? (() => false);
  const desired: DesiredActivation[] = [];
  for (const pointer of input.pointers) {
    for (const node of pointer.ir.nodes) {
      if (!isTriggerNode(node)) continue;
      // A null kind = no runtime activation (the manual trigger) — never materialize it.
      const kind = input.kindOf(node);
      if (kind === null) continue;
      desired.push({
        key: {
          workflowId: input.workflowId,
          environmentId: pointer.environmentId,
          triggerNodeId: node.id,
        },
        kind,
        triggerType: node.node_type,
        versionId: pointer.versionId,
        props: node.parameters,
        connection: input.connectionOf(pointer.environmentId, node),
        paused: pausedOf(pointer.environmentId, node),
      });
    }
  }
  return desired;
}

/** What to do with the dedup/schedule cursor on an update (Obstacle 3). */
export type CursorAction = 'keep' | 'reset';

export interface ActivationUpdate {
  desired: DesiredActivation;
  actual: ActualActivation;
  cursorAction: CursorAction;
}

export interface ReconcilePlan {
  toCreate: DesiredActivation[];
  toUpdate: ActivationUpdate[];
  toDelete: ActualActivation[];
}

/**
 * The idempotent desired-vs-actual sweep. Cursor handoff: an UNCHANGED descriptor keeps its cursor
 * across a version move (a promote must not replay dedup); a changed one resets it from now.
 */
export function reconcileActivations(
  desired: DesiredActivation[],
  actual: ActualActivation[],
): ReconcilePlan {
  const actualByKey = new Map(actual.map((a) => [activationKeyString(a.key), a]));
  const desiredKeys = new Set(desired.map((d) => activationKeyString(d.key)));

  const toCreate: DesiredActivation[] = [];
  const toUpdate: ActivationUpdate[] = [];

  for (const d of desired) {
    const match = actualByKey.get(activationKeyString(d.key));
    if (!match) {
      toCreate.push(d);
      continue;
    }
    if (!activationDescriptorEqual(d, match)) {
      toUpdate.push({ desired: d, actual: match, cursorAction: 'reset' });
    } else if (d.versionId !== match.versionId) {
      // Same config, new version answering: keep the cursor, but record the version.
      toUpdate.push({ desired: d, actual: match, cursorAction: 'keep' });
    }
  }

  const toDelete = actual.filter((a) => !desiredKeys.has(activationKeyString(a.key)));
  return { toCreate, toUpdate, toDelete };
}
