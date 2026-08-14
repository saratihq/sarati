import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { DomainError } from '../common/domain-error';
import { requirePrincipal } from '../auth/principal';
import { TriggersService } from './triggers.service';
import { Scope } from '../auth/scope.decorator';
import { isIdShape } from '../database/ids';
import { PlatformKeysService } from '../platform/platform-keys.service';

/**
 * The trigger picker catalog + the per-workflow activation-health readout (ADR 0018). Triggers
 * are authored as version-doc nodes, so there is deliberately no imperative create/deploy API.
 */
@Controller('api/triggers')
@UseGuards(AuthGuard)
export class TriggersController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  /** The trigger picker catalog: the native webhook + schedule kinds, then every provider trigger. */
  @Scope('workflow:read')
  @Get('catalog')
  async catalog(@Req() req: Request): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    const scope = await this.platformKeys.scopeFor(principal.user.id, principal.activeOrgId);
    return { triggers: await this.triggers.catalog(scope) };
  }

  /**
   * Runtime health of a workflow's canvas-trigger activations (ADR 0018) — whether a LIVE
   * trigger is actually firing, not just its publish state. The service authorizes the read.
   */
  @Scope('workflow:read')
  @Get('activations')
  async activations(
    @Req() req: Request,
    @Query('workflow_id') workflowId?: string,
  ): Promise<Record<string, unknown>> {
    if (workflowId === undefined || !isIdShape(workflowId)) {
      throw new DomainError('workflow_id must be a UUID');
    }
    return { activations: await this.triggers.activationHealth(requirePrincipal(req), workflowId) };
  }
}
