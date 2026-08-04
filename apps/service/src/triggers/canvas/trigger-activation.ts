import { deepEqual } from '../../ir/models';

/**
 * Canvas triggers (ADR 0018): the desired/actual activation descriptors and the
 * descriptor-equality guard the reconciler applies. `reconcile.ts` holds the sweep.
 */

/**
 * How an activation is materialized against the outside world. `composio_subscription`
 * (ADR 0046) is the DEFAULT for a `<app>.<trigger>` catalog trigger that is not a native
 * kind, an SDK registered-webhook, or a hand-polled Composio-poll exception (`polling`);
 * `webhook` and `chat` stand up no remote side-effect — their intake URL IS the deployment.
 */
export type ActivationKind =
  'webhook' | 'chat' | 'registered_webhook' | 'polling' | 'schedule' | 'composio_subscription';

/**
 * A connection reference resolved from an env slot (ADR 0014) — never a secret. `null` means the
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
}

/** The materialized "what IS live" — mirrors a `runtime_trigger_activations` row. */
export type ActualActivation = DesiredActivation;

/** Canonical string form of a key — the map/dedup key across desired and actual. */
export function activationKeyString(key: ActivationKey): string {
  return `${key.workflowId}:${key.environmentId}:${key.triggerNodeId}`;
}

/** Whether two connection refs name the same account (both `null` counts as equal). */
export function connectionEqual(a: ConnectionRef | null, b: ConnectionRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.connectionId === b.connectionId && a.ownerUserId === b.ownerUserId;
}

/**
 * Does the ACTIVATION INTENT match (kind, props, connection, paused)? `props` equality MUST use the
 * vault's `deepEqual`, never `JSON.stringify` (invariant #4). The authoritative cross-version
 * "did the trigger config change" primitive lives in `trigger-config-diff.ts`.
 */
export function activationDescriptorEqual(a: DesiredActivation, b: ActualActivation): boolean {
  return (
    a.kind === b.kind &&
    a.paused === b.paused &&
    connectionEqual(a.connection, b.connection) &&
    deepEqual(a.props, b.props)
  );
}
