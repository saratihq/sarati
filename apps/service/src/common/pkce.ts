import { createHash, randomBytes } from 'node:crypto';

/** CSPRNG output as base64url — `bytes` of entropy. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE S256 challenge = base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
