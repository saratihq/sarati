import { errorMessage } from '../common/error-message';

const MAX_LENGTH = 1000;
/** `String(err)` on a thrown Error glues its class name on: "TypeError: fetch failed". */
const ERROR_CLASS_PREFIX = /^[A-Z]\w*Error:\s*/;
const UNREACHABLE = "Couldn't reach it — check the address is right and reachable from the internet.";

/**
 * A failed activation's `last_error`. This string is PRODUCT COPY: it is shown on the workflow
 * overview and returned by `POST /api/deploy`, so it must never carry a JS error class.
 * The one definition site — every writer of `last_error` goes through here.
 */
export function activationError(err: unknown): string {
  const message = errorMessage(err).trim().replace(ERROR_CLASS_PREFIX, '');
  // All the SDK's HTTP client knows about a transport throw; on its own it tells the user nothing.
  if (message.toLowerCase() === 'fetch failed') return UNREACHABLE;
  return message.slice(0, MAX_LENGTH);
}
