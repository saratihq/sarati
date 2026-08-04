import { Controller, Get, HttpException, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../common/crypto/encryption.service';
import type { EnvConfig } from '../config/env.config';
import { PolicyService } from '../policy/policy.service';
import type { WorkflowEntity } from '../database/entities/workflow.entity';
import { DiffService } from './diff.service';
import { VersionsReadService, type VersionRef } from './versions-read.service';
import { WorkflowsReadService } from './workflows-read.service';
import { Scope } from '../auth/scope.decorator';

/** The workflow read surface; EVERY workflow-scoped route passes the policy check. */
@Controller('api/workflows')
@UseGuards(AuthGuard)
export class WorkflowsController {
  constructor(
    private readonly reads: WorkflowsReadService,
    private readonly versions: VersionsReadService,
    private readonly diffs: DiffService,
    private readonly policy: PolicyService,
    private readonly envConfig: ConfigService<{ env: EnvConfig }, true>,
    private readonly encryption: EncryptionService,
  ) {}

  @Scope('workflow:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    return this.reads.listWorkflows(
      principal.user.id,
      principal.activeOrgId,
      parseIntOr(limit, 50),
      parseIntOr(offset, 0),
    );
  }

  @Scope('workflow:read')
  @Get(':workflowId')
  async get(@Req() req: Request, @Param('workflowId') workflowId: string): Promise<Record<string, unknown>> {
    await this.authorizeRead(req, workflowId);
    return this.reads.getWorkflow(workflowId);
  }

  @Scope('workflow:read')
  @Get(':workflowId/config')
  async config(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
  ): Promise<Record<string, unknown>> {
    await this.authorizeRead(req, workflowId);
    return this.reads.getConfig(workflowId);
  }

  @Scope('workflow:read')
  @Get(':workflowId/versions')
  async listVersions(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Query('branch') branch?: string,
  ): Promise<Record<string, unknown>> {
    await this.authorizeRead(req, workflowId);
    return this.versions.listVersions(workflowId, branch ?? null);
  }

  @Scope('workflow:read')
  @Get(':workflowId/versions/:versionNumber')
  async getVersion(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Query('branch') branch?: string,
  ): Promise<Record<string, unknown>> {
    await this.authorizeRead(req, workflowId);
    return this.versions.getVersion(workflowId, versionNumber, branch ?? null);
  }

  @Scope('workflow:read')
  @Get(':workflowId/diff')
  async diff(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Query('from_version') fromVersion = '0',
    @Query('to_version') toVersion = '0',
    @Query('from_version_id') fromVersionId?: string,
    @Query('to_version_id') toVersionId?: string,
    @Query('branch') branch?: string,
    @Query('from_branch') fromBranch?: string,
    @Query('to_branch') toBranch?: string,
  ): Promise<Record<string, unknown>> {
    // Authorized inside the service, so the MCP surface hits the same check (ADR 0052).
    return this.diffs.getDiff(
      requirePrincipal(req),
      workflowId,
      versionRef(fromVersionId, fromVersion, fromBranch ?? branch),
      versionRef(toVersionId, toVersion, toBranch ?? branch),
    );
  }

  /** 404 unknown, 403 not-yours; a NULL owner AND NULL org denies. */
  private async authorizeRead(req: Request, workflowId: string): Promise<WorkflowEntity> {
    const wf = await this.reads.getWorkflowEntity(workflowId);
    const allowed = await this.policy.can(requirePrincipal(req), 'read', {
      orgId: wf.orgId,
      ownerUserId: wf.userId,
    });
    if (!allowed) throw new HttpException({ detail: 'Not authorised to access this workflow' }, 403);
    return wf;
  }
}

function parseIntOr(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

/** A version id wins outright; a bare number is per-branch and carries whichever branch was named. */
function versionRef(id: string | undefined, number: string, branch: string | undefined): VersionRef {
  return id ? { id } : { number: parseIntOr(number, 0), branch: branch ?? null };
}
