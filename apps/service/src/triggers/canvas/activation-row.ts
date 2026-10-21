import type { RuntimeTriggerActivationEntity } from '../../database/entities/runtime-trigger-activation.entity';
import { deepEqual, type WorkflowIR } from '../../ir/models';
import {
  type ActivationKey,
  type ActivationKind,
  type ActualActivation,
  type ConnectionRef,
  type DesiredActivation,
  triggerPropsOf,
} from './trigger-activation';
import { sameWebhookIntake } from './webhook-url';

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
    webhookUrl: row.webhookUrl,
    // A snapshot recorded before migration 032 has no URL.
    materialized: row.materialized && {
      ...row.materialized,
      webhookUrl: row.materialized.webhookUrl ?? null,
    },
  };
}

/** A trigger as an activation holds it: its node type and props, and where named, the URL its webhook is served at. */
export type HeldTrigger = Pick<DesiredActivation, 'triggerType' | 'props'> &
  Partial<Pick<DesiredActivation, 'webhookUrl'>>;

/** The trigger node `triggerNodeId` of a version, as an activation would hold it; null when the version has none by that id. */
export function triggerOf(ir: WorkflowIR, triggerNodeId: string): HeldTrigger | null {
  const node = ir.nodes.find((n) => n.id === triggerNodeId);
  return node ? { triggerType: node.node_type, props: triggerPropsOf(node) } : null;
}

/** Whether a row holds `trigger` as it is live — same node type and props, and where `trigger` names its webhook's URL, registered at that URL's intake, which a delivery is routed to by path alone — which a delivery or a poll needs to fire that trigger's version (#11). */
export function holdsTrigger(
  row: Pick<RuntimeTriggerActivationEntity, 'kind' | 'triggerType' | 'props' | 'webhookUrl'>,
  trigger: HeldTrigger | null,
): boolean {
  if (trigger?.triggerType !== row.triggerType || !deepEqual(trigger.props, row.props ?? {})) return false;
  return (
    trigger.webhookUrl === undefined ||
    row.kind !== 'registered_webhook' ||
    sameWebhookIntake(trigger.webhookUrl, row.webhookUrl)
  );
}

function connectionOf(row: RuntimeTriggerActivationEntity): ConnectionRef | null {
  return row.connectionId && row.connectionOwnerUserId
    ? { connectionId: row.connectionId, ownerUserId: row.connectionOwnerUserId }
    : null;
}
