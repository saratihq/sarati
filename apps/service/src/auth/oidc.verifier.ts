import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify } from 'jose';

import type { EnvConfig } from '../config/env.config';
import { InvalidTokenError, TokenExpiredError } from './auth.errors';
import type { TokenVerifier, VerifiedIdentity } from './token-verifier';

/**
 * Bring-your-own-IdP verifier: JWTs checked against OIDC_ISSUER's JWKS, users provisioned from the claims.
 * Inert when OIDC_ISSUER is unset, and a foreign `iss` is passed on rather than rejected, so Clerk can coexist.
 */
@Injectable()
export class OidcVerifier implements TokenVerifier {
  readonly name = 'oidc';

  private readonly logger = new Logger(OidcVerifier.name);
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  async verify(token: string): Promise<VerifiedIdentity | null> {
    const env = this.config.get('env', { infer: true });
    const issuer = env.oidcIssuer.trim();
    if (!issuer) return null; // OIDC not configured — inert.

    // Leave another issuer's token — and a malformed one — for the next verifier rather than rejecting it.
    let unverifiedIss: string | undefined;
    try {
      unverifiedIss = decodeJwt(token).iss;
    } catch {
      return null;
    }
    if (unverifiedIss !== issuer) return null;

    if (this.jwks === null) {
      const jwksUrl = env.oidcJwksUrl.trim() || `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
      this.jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 5_000 });
    }

    const audience = env.oidcAudience.trim() || undefined;
    let payload: {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      preferred_username?: string;
    };
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer,
        audience,
        algorithms: ['RS256'],
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError();
      throw new InvalidTokenError(err instanceof Error ? err.message : 'Invalid token');
    }

    if (!payload.sub) throw new InvalidTokenError('Token has no subject');
    // Trust the email claim only when verified: an unverified one could adopt-by-email into another account.
    const email =
      payload.email_verified === true && payload.email?.trim()
        ? payload.email.trim()
        : `${payload.sub}@oidc.local`;
    const name = payload.name?.trim() || payload.preferred_username?.trim() || email;
    return { clerkUserId: payload.sub, email, name };
  }
}
