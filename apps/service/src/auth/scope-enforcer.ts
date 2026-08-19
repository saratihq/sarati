import { ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { Principal } from './principal';
import { SCOPE_METADATA } from './scope.decorator';
import { type ApiScope, NON_GRANTABLE_SCOPE, scopeSatisfied } from './scopes';

/**
 * Scope check for API keys: sessions pass, keys need the route's scope, unannotated denies.
 * Must be called from AuthGuard, NOT registered globally — Nest runs global guards before any principal exists.
 */
@Injectable()
export class ScopeEnforcer {
  private readonly logger = new Logger(ScopeEnforcer.name);

  constructor(private readonly reflector: Reflector) {}

  enforce(principal: Principal, context: ExecutionContext): void {
    if (principal.kind !== 'api_key') return;

    const declared = this.reflector.getAllAndOverride<ApiScope[] | undefined>(SCOPE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const required = declared ?? [];

    if (required.length === 0) {
      const req = context.switchToHttp().getRequest<Request>();
      this.logger.warn(`API-key request denied: ${req.method} ${req.path} declares no scope`);
      throw new ForbiddenException({
        detail: 'This endpoint is not available to API keys. Use a signed-in session.',
      });
    }

    if (required.some((scope) => scopeSatisfied(principal.scopes, scope))) return;

    throw new ForbiddenException({
      detail: required.includes(NON_GRANTABLE_SCOPE)
        ? 'API keys cannot manage API keys. Use a signed-in session.'
        : `This API key is missing the ${required.map((s) => `"${s}"`).join(' or ')} scope.`,
    });
  }
}
