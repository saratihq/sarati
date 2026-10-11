import { ActionError } from '@sarati/actions-sdk';

import { errorMessage } from '../common/error-message';

const MAX_LENGTH = 1000;
/** `String(err)` on a thrown Error glues its class name on: "TypeError: Invalid URL". */
const ERROR_CLASS_PREFIX = /^[A-Z]\w*Error:\s*/;

/**
 * A failed activation's `last_error`. This string is PRODUCT COPY: it is shown on the workflow
 * overview and returned by `POST /api/deploy`, so it must never carry a JS error class.
 * The one definition site — every writer of `last_error` goes through here.
 */
export function activationError(err: unknown): string {
  const unreachable = unreachableTarget(err);
  const message = unreachable
    ? `Couldn't reach ${unreachable.origin} (${unreachable.reason}) — check the address, and any egress proxy in between.`
    : errorMessage(err).trim().replace(ERROR_CLASS_PREFIX, '');
  return message.slice(0, MAX_LENGTH);
}

// The SDK says where it could not get to and why, so the copy does not parse its message.
function unreachableTarget(err: unknown): { origin: string; reason: string } | null {
  if (!(err instanceof ActionError) || err.code !== 'transport_unreachable') return null;
  const detail = err.detail as { origin?: unknown; reason?: unknown } | undefined;
  if (typeof detail?.origin !== 'string' || typeof detail.reason !== 'string') return null;
  return { origin: detail.origin, reason: detail.reason };
}
