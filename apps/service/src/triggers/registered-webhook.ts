import type { WebhookRegistration } from '@sarati/actions-sdk';

import { isRecord } from '../common/json-util';
import { deepEqual } from '../ir/models';
import { validatedAppSlug } from '../providers/sdk-actions.registry';
import type { ConnectionRef } from './canvas/trigger-activation';

/** An app webhook as it was registered: everything its delete needs, recorded when it was created. */
export interface RegisteredWebhook {
  /** The SDK trigger type that registered it. */
  triggerType: string;
  /** The trigger's props when it was registered. */
  props: Record<string, unknown>;
  /** The connection it was registered with; `null` when its trigger needs none. */
  connection: ConnectionRef | null;
  /** The intake URL the app was told to call. */
  webhookUrl: string;
  /** The signing secret we registered it with. */
  secret: string;
  /** The app's handle for it, as `onEnable` returned it. */
  registration: WebhookRegistration;
}

/** The record stored under the registration key, or `null` for a bare handle an earlier release stored. */
export function registeredWebhookOf(stored: unknown): RegisteredWebhook | null {
  return isRecord(stored) && typeof stored.triggerType === 'string' && isRecord(stored.registration)
    ? (stored as unknown as RegisteredWebhook)
    : null;
}

/** A bare handle an earlier release stored under the registration key; `null` for anything else. */
export function legacyRegistrationOf(stored: unknown): WebhookRegistration | null {
  return isRecord(stored) && typeof stored.subscriptionId === 'string'
    ? (stored as unknown as WebhookRegistration)
    : null;
}

/** The app's handle in whatever the registration key holds. */
export function webhookRegistrationOf(stored: unknown): WebhookRegistration | null {
  return registeredWebhookOf(stored)?.registration ?? legacyRegistrationOf(stored);
}

/** Whether two handles name one registration in one app: an upsert (Typeform's tag) can hand a new trigger an old one's. */
export function sameRegistration(
  a: Pick<RegisteredWebhook, 'triggerType' | 'registration'>,
  b: Pick<RegisteredWebhook, 'triggerType' | 'registration'>,
): boolean {
  return (
    validatedAppSlug(a.triggerType) === validatedAppSlug(b.triggerType) &&
    deepEqual(locator(a.registration), locator(b.registration))
  );
}

function locator({ signingSecret: _minted, ...where }: WebhookRegistration): Record<string, unknown> {
  return where;
}
