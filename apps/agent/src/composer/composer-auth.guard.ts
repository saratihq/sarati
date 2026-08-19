import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import type { Request } from 'express';

import type { EnvConfig } from '../config/env.config';

/**
 * Caller auth on /api/composer/*, over two independent paths:
 *
 * - **Clerk** (A2): networkless RS256 verification of the caller's session JWT
 *   against the instance JWKS — issuer + exp checked, optional azp allow-list,
 *   `aud` not verified (Clerk session tokens carry none). Mirrors
 *   workflow-service's ClerkVerifier.
 * **Local session** (workflow-service): a self-host signs in with
 *   email + password and gets an HS256 JWT signed with the shared SECRET_KEY.
 *   Without this path the composer 401s every self-host caller, so an operator
 *   who supplied ANTHROPIC_API_KEY still could not reach it.
 *
 * Each path pins its OWN issuer and algorithm, so a token minted for one can
 * never be accepted by the other — the property relies on. Local runs
 * first: it is networkless, and it is the only path a self-host has.
 *
 * The RAW bearer is attached to the request: tool calls forward it so
 * workflow-service executes AS the caller (its verifier chain accepts both
 * token families). MOCK_AUTH=true bypasses (dev parity with workflow-service).
 */

/** Mirrors workflow-service's LOCAL_ISSUER — only local sessions carry it. */
export const LOCAL_ISSUER = 'orchestr:local';

/** Injectable verification seam so unit tests don't need a live JWKS. */
export const TOKEN_VERIFY = Symbol('TOKEN_VERIFY');
export type TokenVerifyFn = (token: string, env: EnvConfig) => Promise<{ azp?: string; sub?: string }>;

const CALLER_TOKEN = Symbol('composerCallerToken');
const CALLER_SUB = Symbol('composerCallerSub');

/** The one identity every MOCK_AUTH caller shares — dev only (no token, no sub). */
export const MOCK_USER_KEY = 'mock-user';

export function callerTokenOf(req: Request): string | null {
  return (req as unknown as Record<symbol, string | null>)[CALLER_TOKEN] ?? null;
}

/** The verified `sub` — the durable composer-thread key (user, workflow). */
export function callerSubOf(req: Request): string | null {
  return (req as unknown as Record<symbol, string | null>)[CALLER_SUB] ?? null;
}

/**
 * The user id named by a local-session token, or null when the token is well
 * formed but carries no subject. Throws when it is not a valid local session —
 * the guard reads JWTExpired off that to keep saying "Token expired".
 */
export async function verifyLocalSession(token: string, secret: string): Promise<string | null> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: LOCAL_ISSUER,
    algorithms: ['HS256'],
  });
  return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export const joseVerify: TokenVerifyFn = async (token, env) => {
  if (!env.clerkIssuer) throw new Error('CLERK_ISSUER is not configured');
  if (jwks === null) {
    jwks = createRemoteJWKSet(new URL(`${env.clerkIssuer}/.well-known/jwks.json`), {
      timeoutDuration: 5_000,
    });
  }
  const { payload } = await jwtVerify(token, jwks, { issuer: env.clerkIssuer, algorithms: ['RS256'] });
  return payload;
};

@Injectable()
export class ComposerAuthGuard implements CanActivate {
  private readonly logger = new Logger(ComposerAuthGuard.name);
  private readonly verify: TokenVerifyFn;

  constructor(
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    @Optional() @Inject(TOKEN_VERIFY) verify?: TokenVerifyFn,
  ) {
    this.verify = verify ?? joseVerify;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const env = this.config.get('env', { infer: true });
    const req = context.switchToHttp().getRequest<Request>();

    if (env.mockAuth) {
      (req as unknown as Record<symbol, string | null>)[CALLER_TOKEN] = null;
      (req as unknown as Record<symbol, string | null>)[CALLER_SUB] = MOCK_USER_KEY;
      return true;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    if (!token) throw new UnauthorizedException({ message: 'Not authenticated' });

    let sub: string | null = null;
    // Expiry from EITHER path still reports as expiry: the token the caller
    // holds is a lapsed one, whichever path would have accepted it fresh.
    let expired = false;
    let rejection: string | null = null;

    if (env.localSessionSecret) {
      try {
        sub = await verifyLocalSession(token, env.localSessionSecret);
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) expired = true;
        rejection = err instanceof Error ? err.message : String(err);
      }
    }

    // Skipped when Clerk is unconfigured: on a self-host that is the normal
    // state, and attempting it would log a misleading "CLERK_ISSUER is not
    // configured" on every bad token.
    if (sub === null && env.clerkIssuer) {
      try {
        sub = this.clerkSub(await this.verify(token, env), env);
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) expired = true;
        rejection = err instanceof Error ? err.message : String(err);
      }
    }

    if (sub === null) {
      if (rejection !== null) this.logger.warn(`token rejected: ${rejection}`);
      throw new UnauthorizedException({ message: expired ? 'Token expired' : 'Invalid token' });
    }

    (req as unknown as Record<symbol, string | null>)[CALLER_TOKEN] = token;
    (req as unknown as Record<symbol, string | null>)[CALLER_SUB] = sub;
    return true;
  }

  private clerkSub(payload: { azp?: string; sub?: string }, env: EnvConfig): string | null {
    const parties = env.clerkAuthorizedParties
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parties.length > 0 && payload.azp && !parties.includes(payload.azp)) return null;
    return payload.sub ?? null;
  }
}
