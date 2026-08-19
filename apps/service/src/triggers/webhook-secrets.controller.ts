import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';

import { AuthGuard } from '../auth/auth.guard';
import { principalOf } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { EnvironmentsService } from '../environments/environments.service';
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
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly environments: EnvironmentsService,
    private readonly secrets: WebhookSecretsService,
  ) {}

  @Scope('connection:write')
  @Put()
  async set(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: SetSecretDto,
  ): Promise<{ status: string }> {
    const { wf, environmentId } = await this.resolve(req, workflowId, body.environment);
    await this.secrets.setSecret(wf.id, environmentId, body.node_id, body.secret);
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
    const { wf, environmentId } = await this.resolve(req, workflowId, environment);
    return { secret_present: await this.secrets.hasSecret(wf.id, environmentId, nodeId) };
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
    const { wf, environmentId } = await this.resolve(req, workflowId, environment);
    const removed = await this.secrets.clearSecret(wf.id, environmentId, nodeId);
    return { status: removed ? 'cleared' : 'absent' };
  }

  /** Authorize the caller against the workflow, and resolve the env name → id. */
  private async resolve(
    req: Request,
    workflowId: string,
    environment: string | undefined,
  ): Promise<{ wf: WorkflowEntity; environmentId: string | null }> {
    const principal = principalOf(req);
    if (!principal) throw new DomainError('Unauthorized', 401);
    if (!isIdShape(workflowId)) throw new DomainError('Workflow not found', 404);
    const em = this.dataSource.manager;
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    // A foreign workflow must be an indistinguishable 404, never a 403.
    const owns =
      wf !== null &&
      ((wf.orgId !== null && wf.orgId === principal.activeOrgId) ||
        (wf.userId !== null && wf.userId === principal.user.id));
    if (!wf || !owns) throw new DomainError('Workflow not found', 404);

    let environmentId: string | null = null;
    if (environment && wf.orgId) {
      const env = await this.environments.findByNameForOrg(em, wf.orgId, environment);
      if (!env) throw new DomainError('Environment not found', 404);
      environmentId = env.id;
    }
    return { wf, environmentId };
  }
}
