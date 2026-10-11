import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { WorkflowAccessService } from '../workflows/workflow-access.service';
import { WebhookSecretsService } from './webhook-secrets.service';
import { Scope } from '../auth/scope.decorator';

class SetSecretDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  node_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  secret!: string;

  /** Environment name (matches the intake path); omit for the org-less/prod default. */
  @IsOptional()
  @IsString()
  environment?: string;
}

/**
 * Set/clear the env-scoped webhook signing SECRET (native HMAC) through a
 * dedicated authenticated endpoint — NEVER the version-doc save path, so the secret
 * never enters a diff/review. The non-secret verification config lives on the node.
 */
@Controller('api/workflows/:workflowId/webhook-secret')
@UseGuards(AuthGuard)
export class WebhookSecretsController {
  constructor(
    private readonly secrets: WebhookSecretsService,
    private readonly access: WorkflowAccessService,
  ) {}

  @Scope('connection:write')
  @Put()
  async set(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: SetSecretDto,
  ): Promise<{ status: string }> {
    const wf = await this.access.require(requirePrincipal(req), workflowId, 'write');
    await this.secrets.setSecret(wf, body.environment, body.node_id, body.secret);
    return { status: 'set' };
  }

  /**
   * Whether a signing secret is stored for this node in this env. Returns a boolean ONLY —
   * the secret is write-only and must never leave the server.
   */
  @Scope('connection:read')
  @Get()
  async status(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Query('node_id') nodeId: string,
    @Query('environment') environment?: string,
  ): Promise<{ secret_present: boolean }> {
    if (!nodeId) throw new DomainError('node_id is required', 400);
    const wf = await this.access.require(requirePrincipal(req), workflowId, 'read');
    return { secret_present: await this.secrets.hasSecret(wf, environment, nodeId) };
  }

  @Scope('connection:write')
  @Delete()
  async clear(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Query('node_id') nodeId: string,
    @Query('environment') environment?: string,
  ): Promise<{ status: string }> {
    if (!nodeId) throw new DomainError('node_id is required', 400);
    const wf = await this.access.require(requirePrincipal(req), workflowId, 'write');
    const removed = await this.secrets.clearSecret(wf, environment, nodeId);
    return { status: removed ? 'cleared' : 'absent' };
  }
}
