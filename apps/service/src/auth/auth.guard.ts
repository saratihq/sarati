import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { DomainError } from '../common/domain-error';
import type { EnvConfig } from '../config/env.config';
import type { UserEntity } from '../database/entities/user.entity';
import { OrgsService } from '../orgs/orgs.service';
import { InvalidTokenError, TokenExpiredError } from './auth.errors';
import { ScopeEnforcer } from './scope-enforcer';
import { attachPrincipal, type Principal } from './principal';
import { TOKEN_VERIFIERS, type TokenVerifier } from './token-verifier';
import { UserProvisioningService } from './user-provisioning.service';

/** Runs the verifier chain and attaches the principal, carrying the request's active org (X-Org-Id → personal). */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly provisioning: UserProvisioningService,
    private readonly orgs: OrgsService,
    @Inject(TOKEN_VERIFIERS) private readonly verifiers: readonly TokenVerifier[],
    private readonly scopes: ScopeEnforcer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const env = this.config.get('env', { infer: true });
    const req = context.switchToHttp().getRequest<Request>();

    if (env.mockAuth) {
      await this.attach(req, await this.provisioning.getOrCreateMockUser());
      return true;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    if (!token) {
      context.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException({ detail: 'Not authenticated' });
    }

    try {
      for (const verifier of this.verifiers) {
        const identity = await verifier.verify(token);
        if (!identity) continue;
        const user = identity.userId
          ? await this.provisioning.getById(identity.userId)
          : identity.clerkUserId
            ? identity.email
              ? // OIDC self-host: provision from token claims (no external fetch).
                await this.provisioning.getOrProvisionFromClaims(
                  identity.clerkUserId,
                  identity.email,
                  identity.name ?? identity.email,
                )
              : await this.provisioning.getOrProvision(identity.clerkUserId)
            : null;
        if (!user) throw new InvalidTokenError('Token identity did not resolve to a user');
        const principal = await this.attach(req, user, identity.apiKey);
        // Here, not a global guard: Nest runs those before any principal exists.
        this.scopes.enforce(principal, context);
        return true;
      }
      throw new InvalidTokenError('No verifier accepted the token');
    } catch (err) {
      if (err instanceof TokenExpiredError || err instanceof InvalidTokenError) {
        // Operator-only: the 401 body stays generic so it tells an attacker nothing about the token.
        this.logger.warn(`Token rejected: ${err.message}`);
      }
      if (err instanceof TokenExpiredError) {
        throw new UnauthorizedException({ detail: 'Token expired' });
      }
      if (err instanceof InvalidTokenError) {
        throw new UnauthorizedException({ detail: 'Invalid token' });
      }
      throw err;
    }
  }

  /** Resolve the active org and attach the principal; an org-pinned key mismatch is refused, not coerced. */
  private async attach(
    req: Request,
    user: UserEntity,
    apiKey?: { scopes: string[] | null; orgId: string | null },
  ): Promise<Principal> {
    const raw = req.headers['x-org-id'];
    const requested = Array.isArray(raw) ? raw[0] : raw;

    if (apiKey?.orgId && requested?.trim() && requested.trim() !== apiKey.orgId) {
      throw new DomainError('This API key is scoped to a different organization', 403);
    }

    const active = await this.orgs.resolveActiveOrg(user.id, apiKey?.orgId ?? requested);
    const principal: Principal = apiKey
      ? {
          kind: 'api_key',
          user,
          activeOrgId: active.orgId,
          activeOrgRole: active.role,
          scopes: apiKey.scopes,
          keyOrgId: apiKey.orgId,
        }
      : { kind: 'user', user, activeOrgId: active.orgId, activeOrgRole: active.role };
    attachPrincipal(req, principal);
    return principal;
  }
}
