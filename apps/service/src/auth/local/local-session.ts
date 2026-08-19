import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

/** Only this verifier accepts this issuer, so a local session can never be mistaken for a Clerk/OIDC one. */
export const LOCAL_ISSUER = 'orchestr:local';

/** Long enough for a working day, short enough that a stolen token expires on its own. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** A signed session for a local account; the user id is the subject. */
export async function mintSession(
  userId: string,
  secret: string,
): Promise<{ token: string; expiresAt: string }> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(keyOf(secret));
  return { token, expiresAt: new Date(expires * 1000).toISOString() };
}

/**
 * The user id this session names, or null when it is not a local session at all (wrong issuer,
 * wrong signature, not a JWT). An EXPIRED session is ours and is rethrown, so it can be reported
 * as expired rather than folded into the generic rejection.
 */
export async function readSession(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      issuer: LOCAL_ISSUER,
      algorithms: ['HS256'],
    });
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw err;
    return null;
  }
}
