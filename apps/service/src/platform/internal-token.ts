import { jwtVerify } from 'jose';

/** Its own issuer, so an internal token can never be mistaken for a user session and vice versa. */
export const INTERNAL_ISSUER = 'orchestr:internal';

/** Carried BESIDE the caller's own `Authorization` — the process credential, not the user's. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Short — the caller mints one per request, and a leaked token must not outlive the call. */
export const INTERNAL_TOKEN_TTL_SECONDS = 60;

/** Whether this bearer is a live internal token signed with the shared SECRET_KEY. */
export async function verifyInternalToken(token: string, secret: string): Promise<boolean> {
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: INTERNAL_ISSUER,
      algorithms: ['HS256'],
    });
    return true;
  } catch {
    return false;
  }
}
