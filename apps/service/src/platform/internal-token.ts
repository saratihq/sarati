import { createHash } from 'node:crypto';

import { jwtVerify } from 'jose';

/** Its own issuer, so an internal token can never be mistaken for a user session and vice versa. */
export const INTERNAL_ISSUER = 'orchestr:internal';

/** Carried BESIDE the caller's own `Authorization` — the process credential, not the user's. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Short — the caller mints one per request, and a leaked token must not outlive the call. */
export const INTERNAL_TOKEN_TTL_SECONDS = 60;

/** The one thing an internal token is minted for today: reading the caller's Anthropic key. */
export const PLATFORM_KEYS_AUDIENCE = 'platform-keys:anthropic';

/** Who a token was minted for, as a digest — the token never carries the bearer itself. */
export function callerBinding(bearer: string): string {
  return createHash('sha256').update(bearer).digest('base64url');
}

/** Whether this is a live internal token minted for THIS caller and THIS purpose — a leaked one is useless anywhere else. */
export async function verifyInternalToken(
  token: string,
  secret: string,
  binding: { bearer: string; audience: string },
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: INTERNAL_ISSUER,
      audience: binding.audience,
      algorithms: ['HS256'],
    });
    return payload.sub === callerBinding(binding.bearer);
  } catch {
    return false;
  }
}
