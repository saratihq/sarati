import { isRecord } from '../../common/json-util';
import { deepEqual, type IRNode } from '../../ir/models';

/**
 * Canvas triggers: the desired/actual activation descriptors and the
 * descriptor-equality guard the reconciler applies. `reconcile.ts` holds the sweep.
 */

/**
 * How an activation is materialized against the outside world. `composio_subscription`
 *  is the DEFAULT for a `<app>.<trigger>` catalog trigger that is not a native
 * kind, an SDK registered-webhook, or a hand-polled Composio-poll exception (`polling`);
 * `webhook` and `chat` stand up no remote side-effect — their intake URL IS the deployment.
 */
export type ActivationKind =
  'webhook' | 'chat' | 'registered_webhook' | 'polling' | 'schedule' | 'composio_subscription';

/**
 * A connection reference resolved from an env slot — never a secret. `null` means the
 * kind needs none; an UNFILLED slot is an activation error instead, never a silent `null`.
 */
export interface ConnectionRef {
  connectionId: string;
  ownerUserId: string;
}

/** The stable identity of an activation: exactly one per (workflow, env, trigger node). */
export interface ActivationKey {
  workflowId: string;
  environmentId: string;
  /** The IR node id — `sha256(name)[:12]`; name IS identity (vault), so a rename re-keys. */
  triggerNodeId: string;
}

/** The normalized "what SHOULD be live" for one trigger node under one env pointer. */
export interface DesiredActivation {
  key: ActivationKey;
  kind: ActivationKind;
  /** The node's PUBLIC `node_type` handed to the provider seam; identity is `key.triggerNodeId`. */
  triggerType: string;
  /** The version the env currently points at — observability + the cursor-handoff diff input. */
  versionId: string;
  /** The trigger node's `parameters`. Compared via the vault `deepEqual`, never `JSON.stringify`. */
  props: Record<string, unknown>;
  /** The account resolved from the env slot; `null` for native kinds. */
  connection: ConnectionRef | null;
  /** Operator override: a paused activation is desired-present but not firing. */
  paused: boolean;
  /** The intake URL the provider is told to deliver to (public base + env name); `null` for a kind that registers none. */
  webhookUrl: string | null;
}

/** What the reconciler last stood up for an activation: the descriptor less its key and version. */
export type MaterializedActivation = Pick<
  DesiredActivation,
  'kind' | 'triggerType' | 'props' | 'connection' | 'paused' | 'webhookUrl'
>;

/** A `runtime_trigger_activations` row: the descriptor last applied to it, and what is actually live. */
export interface ActualActivation extends DesiredActivation {
  /** What was last stood up; `null` when nothing is known to be (a row from before this was recorded). */
  materialized: MaterializedActivation | null;
}

/** A trigger node's props as an activation records them: a node saved without parameters has none. */
export function triggerPropsOf(node: Pick<IRNode, 'parameters'>): Record<string, unknown> {
  return isRecord(node.parameters) ? node.parameters : {};
}

/** Canonical string form of a key — the map/dedup key across desired and actual. */
export function activationKeyString(key: ActivationKey): string {
  return `${key.workflowId}:${key.environmentId}:${key.triggerNodeId}`;
}

function connectionEqual(a: ConnectionRef | null, b: ConnectionRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.connectionId === b.connectionId && a.ownerUserId === b.ownerUserId;
}

function activationTargetEqual(a: MaterializedActivation, b: MaterializedActivation): boolean {
  return (
    a.kind === b.kind &&
    a.triggerType === b.triggerType &&
    a.paused === b.paused &&
    a.webhookUrl === b.webhookUrl &&
    connectionEqual(a.connection, b.connection)
  );
}

/** Same target and same props — `props` compared by the vault's `deepEqual`, never `JSON.stringify` (invariant #4). */
export function activationDescriptorEqual(a: MaterializedActivation, b: MaterializedActivation): boolean {
  return activationTargetEqual(a, b) && deepEqual(a.props, b.props);
}

/** Whether the row's last apply finished: a row is written before its side-effects, so one unlike what is recorded as live did not. */
export function applyFinished(
  actual: ActualActivation,
): actual is ActualActivation & { materialized: MaterializedActivation } {
  return actual.materialized !== null && activationDescriptorEqual(actual, actual.materialized);
}
