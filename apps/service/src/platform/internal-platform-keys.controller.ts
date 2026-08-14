import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { Scope } from '../auth/scope.decorator';
import { DomainError } from '../common/domain-error';
import type { EnvConfig } from '../config/env.config';
import { INTERNAL_TOKEN_HEADER, verifyInternalToken } from './internal-token';
import { PlatformKeysService } from './platform-keys.service';

/**
 * The one seam that hands a stored key to another Sarati process: agent-service runs in its own
 * container and needs the caller's Anthropic key per turn.
 *
 * Two credentials, both required. The CALLER's own bearer rides the normal `Authorization`
 * header, so `AuthGuard` resolves exactly the identity and active org the rest of the API would
 * — which is what makes the key it returns the caller's, not someone else's. The PROCESS proves
 * itself with a short-lived HS256 token signed with the SECRET_KEY both already share, so a user
 * token alone can never read a key back out.
 *
 * The reverse proxy does not route `/api/internal/*`; this is reachable on the internal network.
 */
@Controller('api/internal/platform-keys')
@UseGuards(AuthGuard)
export class InternalPlatformKeysController {
  constructor(
    private readonly keys: PlatformKeysService,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
  ) {}

  @Scope('org:manage')
  @Get('anthropic')
  async anthropic(@Req() req: Request): Promise<{ api_key: string | null }> {
    await this.requireInternalCaller(req);
    const principal = requirePrincipal(req);
    const scope = await this.keys.scopeFor(principal.user.id, principal.activeOrgId);
    return { api_key: await this.keys.get(scope, 'anthropic_api_key') };
  }

  private async requireInternalCaller(req: Request): Promise<void> {
    const secret = this.config.get('env', { infer: true }).secretKey;
    const raw = req.headers[INTERNAL_TOKEN_HEADER];
    const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    if (!token || !(await verifyInternalToken(token, secret))) {
      throw new DomainError('Not an internal caller', 401);
    }
  }
}
