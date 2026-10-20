import { isTriggerNode } from '../../compiler/compile-ir';
import { decideBySlot, type RunAsDecision, type SlotAccount } from '../../connections/run-as-account';
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

/** The environment slot a trigger listens as: the app it is for, and which accounts for it serve it. */
export interface TriggerSlot {
  app: string;
  /** Only a one-click (managed) account serves it: it rides a Composio rail. */
  managedOnly: boolean;
  /** Only an account that uses its own credentials serves it: it signs in on the SDK's direct rail. */
  ownCredentialsOnly: boolean;
}

function slotOf(kind: ActivationKind, triggerType: string): TriggerSlot | null {
  const app = listensAsAccount(kind, triggerType) ? validatedAppSlug(triggerType) : null;
  if (!app) return null;
  const managedOnly = listensAsManagedAccount(kind, triggerType);
  // Every other trigger listening as an account signs in on the SDK's direct rail, which a one-click account's credential never reaches.
  return { app, managedOnly, ownCredentialsOnly: !managedOnly };
}

// THE slot a trigger node listens as, or null when it listens as none.
function triggerSlotOf(
  node: Pick<IRNode, 'node_type'> & { metadata?: Record<string, unknown> },
): TriggerSlot | null {
  if (!isTriggerNode(node)) return null;
  const kind = activationKindOf(node.node_type);
  return kind === null ? null : slotOf(kind, node.node_type);
}

/** A trigger node as {@link decideTriggerSlots} reads it. */
export type TriggerNode = Pick<IRNode, 'id' | 'node_type'> & {
  name?: string;
  metadata?: Record<string, unknown>;
};

/** An app trigger judged by its environment's slot: the account in it, and the rule's answer. */
export interface TriggerSlotDecision {
  nodeId: string;
  name: string;
  slot: TriggerSlot;
  account: SlotAccount | null;
  decision: RunAsDecision;
}

/** THE judgement of each app trigger among `nodes` by its environment's slot for its app (#11, by #18's slot half), each slot read once through `readSlot`. */
export function decideTriggerSlots(
  nodes: readonly TriggerNode[],
  environment: string,
  readSlot: (app: string) => Promise<SlotAccount | null>,
): Promise<TriggerSlotDecision[]> {
  const reads = new Map<string, Promise<SlotAccount | null>>();
  const nameOf = (): Promise<string> => Promise.resolve(environment);
  return Promise.all(
    nodes.flatMap((node) => {
      const slot = triggerSlotOf(node);
      if (!slot) return [];
      const read = reads.get(slot.app) ?? readSlot(slot.app);
      reads.set(slot.app, read);
      const name = node.name || node.id;
      return [
        read.then(async (account) => ({
          nodeId: node.id,
          name,
          slot,
          account,
          decision: await decideBySlot({ name, ...slot, connectionId: null }, account, nameOf),
        })),
      ];
    }),
  );
}

/** Whether a held activation still fires what its app sends: a registered webhook or a Composio subscription does, a held poll waits. */
export function firesWhileHeld(kind: ActivationKind): boolean {
  return kind === 'registered_webhook' || kind === 'composio_subscription';
}

/** Whether an activation is held back by its slot, so nothing is stood up, polled or changed at its app for it: it listens as one that serves it no account, or it is `held` — kept, while the account it was stood up with isn't active. */
export function heldBackBySlot(
  activation: Pick<MaterializedActivation, 'kind' | 'triggerType' | 'connection'> & { held?: boolean },
): boolean {
  if (activation.held === true) return true;
  return activation.connection === null && slotOf(activation.kind, activation.triggerType) !== null;
}
