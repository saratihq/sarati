import { isTriggerNode } from '../../compiler/compile-ir';
import type { IRNode } from '../../ir/models';
import { composioTriggerSpec } from '../../providers/composio-trigger.registry';
import { validatedAppSlug } from '../../providers/sdk-actions.registry';
import { isSdkPollingTrigger, sdkPollingTriggerSignsIn } from '../../providers/sdk-polling.provider';
import { isSdkWebhookTrigger } from '../../providers/sdk-webhook.provider';
import { AGENT_TOOL_PUBLIC } from '../../runtime/workflow-tool-contract';
import { ORCHESTR_SCHEDULE } from '../schedule';
import { INCOMING_CHAT_PUBLIC, INCOMING_WEBHOOK_PUBLIC, MANUAL_TRIGGER } from '../trigger-catalog.service';
import type { ActivationKind, MaterializedActivation } from './trigger-activation';

/** How a trigger node of `nodeType` is stood up, or null when nothing is: the manual trigger waits for a Run, the tool trigger for its caller. */
export function activationKindOf(nodeType: string): ActivationKind | null {
  if (nodeType === MANUAL_TRIGGER || nodeType === AGENT_TOOL_PUBLIC) return null;
  if (nodeType === INCOMING_WEBHOOK_PUBLIC) return 'webhook';
  if (nodeType === INCOMING_CHAT_PUBLIC) return 'chat';
  if (nodeType === ORCHESTR_SCHEDULE) return 'schedule';
  if (isSdkWebhookTrigger(nodeType)) return 'registered_webhook';
  if (isSdkPollingTrigger(nodeType)) return 'polling';
  // The hand-polled Composio-poll exceptions keep our poll cycle; every other `<app>.<trigger>` rides the Composio subscription rail.
  if (composioTriggerSpec(nodeType)) return 'polling';
  return 'composio_subscription';
}

// Whether an activation listens as an account; an SDK polling trigger that signs in to nothing listens as none.
function listensAsAccount(kind: ActivationKind, triggerType: string): boolean {
  if (kind === 'polling' && isSdkPollingTrigger(triggerType)) return sdkPollingTriggerSignsIn(triggerType);
  return kind === 'registered_webhook' || kind === 'polling' || kind === 'composio_subscription';
}

// The Composio rails, subscribed or hand-polled, run only on a one-click (managed) account.
function listensAsManagedAccount(kind: ActivationKind, triggerType: string): boolean {
  return kind === 'composio_subscription' || (kind === 'polling' && !isSdkPollingTrigger(triggerType));
}

/** The environment slot a trigger listens as: the app it is for, and whether only a one-click (managed) account serves it. */
export interface TriggerSlot {
  app: string;
  managedOnly: boolean;
}

function slotOf(kind: ActivationKind, triggerType: string): TriggerSlot | null {
  const app = listensAsAccount(kind, triggerType) ? validatedAppSlug(triggerType) : null;
  return app ? { app, managedOnly: listensAsManagedAccount(kind, triggerType) } : null;
}

/** THE slot a trigger node listens as, or null when it listens as none: the slot the reconciler stands it up on and a promote checks. */
export function triggerSlotOf(
  node: Pick<IRNode, 'node_type'> & { metadata?: Record<string, unknown> },
): TriggerSlot | null {
  if (!isTriggerNode(node)) return null;
  const kind = activationKindOf(node.node_type);
  return kind === null ? null : slotOf(kind, node.node_type);
}

/** Whether an activation is held back by its slot, so nothing is stood up or polled for it: it listens as one that serves it no account, or it is `held` — kept, while the account it was stood up with isn't active. */
export function heldBackBySlot(
  activation: Pick<MaterializedActivation, 'kind' | 'triggerType' | 'connection'> & { held?: boolean },
): boolean {
  if (activation.held === true) return true;
  return activation.connection === null && slotOf(activation.kind, activation.triggerType) !== null;
}
