import { SignJWT } from 'jose';

import { LOCAL_ISSUER } from '../composer/composer-auth.guard';

/** Mirrors workflow-service's mintSession — the token a local login hands the client. */
export async function mintLocalSession(
  secret: string,
  sub: string,
  over: { issuer?: string; lifetime?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(over.issuer ?? LOCAL_ISSUER)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (over.lifetime ?? 3600))
    .sign(new TextEncoder().encode(secret));
}
