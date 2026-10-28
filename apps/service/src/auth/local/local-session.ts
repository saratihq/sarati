import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

/** Only this verifier accepts this issuer, so a local session can never be mistaken for a Clerk one. */
export const LOCAL_ISSUER = 'orchestr:local';

/** Long enough for a working day, short enough that a stolen token expires on its own. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** How a session's holder signed in; `method` and `idp` are written into every issued token. */
export type SessionMethod = { method: 'password' } | { method: 'oidc'; idp: string };

/** A verified session: whose it is, and how they signed in. */
export interface LocalSession {
  userId: string;
  via: SessionMethod;
}

/** Which sign-in methods this instance accepts sessions from. */
export interface SessionDoors {
  passwords: boolean;
  /** The configured OIDC issuer while single sign-on is on, else null. */
  ssoIssuer: string | null;
}

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** A signed session for a local account; the user id is the subject. */
export async function mintSession(
  userId: string,
  secret: string,
  via: SessionMethod = { method: 'password' },
): Promise<{ token: string; expiresAt: string }> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const claims = via.method === 'oidc' ? { method: 'oidc', idp: via.idp } : { method: 'password' };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(keyOf(secret));
  return { token, expiresAt: new Date(expires * 1000).toISOString() };
}

// A token minted before sessions named their method carries none, and only passwords minted them then.
function methodOf(payload: Record<string, unknown>): SessionMethod | null {
  if (payload.method === undefined || payload.method === 'password') return { method: 'password' };
  if (payload.method === 'oidc' && typeof payload.idp === 'string' && payload.idp) {
    return { method: 'oidc', idp: payload.idp };
  }
  return null;
}

/** The session this token carries, or null when it is not one of ours; an EXPIRED one is ours and is rethrown, so it can be reported as expired. */
export async function readSession(token: string, secret: string): Promise<LocalSession | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      issuer: LOCAL_ISSUER,
      algorithms: ['HS256'],
    });
    const via = methodOf(payload);
    return typeof payload.sub === 'string' && payload.sub && via ? { userId: payload.sub, via } : null;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw err;
    return null;
  }
}

/** Why this instance refuses a session minted this way, or null when it accepts it. The agent mirrors this rule. */
export function sessionRefusal(via: SessionMethod, doors: SessionDoors): string | null {
  if (via.method === 'password') {
    return doors.passwords ? null : 'a password session, and password sign-in is off (LOCAL_AUTH_ENABLED)';
  }
  if (doors.ssoIssuer === null) return 'a single sign-on session, and single sign-on is off';
  return via.idp === doors.ssoIssuer
    ? null
    : 'a single sign-on session from an issuer other than OIDC_ISSUER';
}
