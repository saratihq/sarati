import { isTriggerNode } from '../../compiler/compile-ir';
import type { IRNode } from '../../ir/models';
import { composioTriggerSpec } from '../../providers/composio-trigger.registry';
import { validatedAppSlug } from '../../providers/sdk-actions.registry';
import { isSdkPollingTrigger, sdkPollingTriggerSignsIn } from '../../providers/sdk-polling.provider';
import { isSdkWebhookTrigger } from '../../providers/sdk-webhook.provider';
import { AGENT_TOOL_PUBLIC } from '../../runtime/workflow-tool-contract';
import { ORCHESTR_SCHEDULE } from '../schedule';
import { INCOMING_CHAT_PUBLIC, INCOMING_WEBHOOK_PUBLIC, MANUAL_TRIGGER } from '../trigger-catalog.service';
import type { ActivationKind } from './trigger-activation';

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

/** Whether an activation listens as an account, its environment's slot for its app; an SDK polling trigger that signs in to nothing listens as none. */
export function listensAsAccount(kind: ActivationKind, triggerType: string): boolean {
  if (kind === 'polling' && isSdkPollingTrigger(triggerType)) return sdkPollingTriggerSignsIn(triggerType);
  return kind === 'registered_webhook' || kind === 'polling' || kind === 'composio_subscription';
}

/** THE app whose environment slot a trigger node listens as, or null when it listens as none: the slot the reconciler stands it up on and a promote checks. */
export function triggerSlotApp(
  node: Pick<IRNode, 'node_type'> & { metadata?: Record<string, unknown> },
): string | null {
  if (!isTriggerNode(node)) return null;
  const kind = activationKindOf(node.node_type);
  return kind !== null && listensAsAccount(kind, node.node_type) ? validatedAppSlug(node.node_type) : null;
}
