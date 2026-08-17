import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify } from 'jose';

import type { EnvConfig } from '../config/env.config';
import { InvalidTokenError, TokenExpiredError } from './auth.errors';
import type { TokenVerifier, VerifiedIdentity } from './token-verifier';

/** RS256 verification against the instance JWKS: issuer + exp + optional azp; `aud` is NOT checked (Clerk sends none). */
@Injectable()
export class ClerkVerifier implements TokenVerifier {
  readonly name = 'clerk';

  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  async verify(token: string): Promise<VerifiedIdentity | null> {
    const env = this.config.get('env', { infer: true });
    if (!env.clerkIssuer) return null; // Clerk not configured — inert, like OIDC.

    // Leave another issuer's token — and a malformed one — for the next verifier rather than
    // rejecting it: throwing here would reject tokens this verifier does not own.
    let unverifiedIss: string | undefined;
    try {
      unverifiedIss = decodeJwt(token).iss;
    } catch {
      return null;
    }
    if (unverifiedIss !== env.clerkIssuer) return null;

    if (this.jwks === null) {
      const url = new URL(`${env.clerkIssuer.replace(/\/+$/, '')}/.well-known/jwks.json`);
      this.jwks = createRemoteJWKSet(url, { timeoutDuration: 5_000 });
    }

    let payload: { sub?: string; azp?: string };
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: env.clerkIssuer,
        algorithms: ['RS256'],
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError();
      throw new InvalidTokenError(err instanceof Error ? err.message : 'Invalid token');
    }

    const parties = env.clerkAuthorizedParties
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parties.length > 0 && payload.azp && !parties.includes(payload.azp)) {
      throw new InvalidTokenError(`Unauthorized party ${payload.azp}`);
    }
    if (!payload.sub) throw new InvalidTokenError('Token has no subject');

    return { clerkUserId: payload.sub };
  }
}
