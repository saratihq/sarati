import type { RuntimeTriggerActivationEntity } from '../../database/entities/runtime-trigger-activation.entity';
import type { ActivationKey, ActivationKind, ActualActivation, ConnectionRef } from './trigger-activation';

/** The activation key a row is stored under. */
export function activationKeyOf(row: RuntimeTriggerActivationEntity): ActivationKey {
  return { workflowId: row.workflowId, environmentId: row.environmentId, triggerNodeId: row.triggerNodeId };
}

/** A row as the planner reads it: the descriptor last applied to it, and what is recorded as live. */
export function actualOf(row: RuntimeTriggerActivationEntity): ActualActivation {
  return {
    key: activationKeyOf(row),
    kind: row.kind as ActivationKind,
    triggerType: row.triggerType,
    versionId: row.versionId ?? '',
    props: row.props ?? {},
    connection: connectionOf(row),
    paused: row.paused,
    materialized: row.materialized,
  };
}

function connectionOf(row: RuntimeTriggerActivationEntity): ConnectionRef | null {
  return row.connectionId && row.connectionOwnerUserId
    ? { connectionId: row.connectionId, ownerUserId: row.connectionOwnerUserId }
    : null;
}
