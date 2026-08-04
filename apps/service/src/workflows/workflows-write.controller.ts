import {
  Body,
  Controller,
  Delete,
  HttpException,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  Patch,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import type { WorkflowEntity } from '../database/entities/workflow.entity';
import { PolicyService, type PolicyAction } from '../policy/policy.service';
import { EnvPointersService } from './env-pointers.service';
import { VersionsWriteService } from './versions-write.service';
import { WorkflowLifecycleService } from './workflow-lifecycle.service';
import { WorkflowsReadService } from './workflows-read.service';
import { versionResponse } from './workflow-responses';
import { Scope } from '../auth/scope.decorator';

class WorkflowUpdateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class CommitDto {
  @IsOptional()
  @IsObject()
  workflow_json?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  workflow_ir?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  branch = 'main';

  @IsOptional()
  @IsString()
  commit_message?: string;

  /** Optimistic concurrency: the head this edit is based on — if the branch has moved off it, the commit 409s. */
  @IsOptional()
  @IsString()
  base_version_id?: string;

  @IsOptional()
  @IsString()
  author?: string;
}

class ProtectionDto {
  @IsIn([true, false])
  is_protected!: boolean;
}

class PublishDto {
  /** Absent → publish the default branch's head (the newest saved version). */
  @IsOptional()
  @IsInt()
  @Min(1)
  version_number?: number;
}

class RestoreDto {
  @IsInt()
  @Min(1)
  version_number!: number;
}

class PromoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  environment!: string;

  @IsString()
  version_id!: string;
}

export { CommitDto, PromoteDto, ProtectionDto, PublishDto, RestoreDto, WorkflowUpdateDto };

/** The workflow write surface; every route passes the policy check. */
@Controller('api/workflows')
@UseGuards(AuthGuard)
export class WorkflowsWriteController {
  private readonly logger = new Logger(WorkflowsWriteController.name);

  constructor(
    private readonly reads: WorkflowsReadService,
    private readonly lifecycle: WorkflowLifecycleService,
    private readonly versionsWrite: VersionsWriteService,
    private readonly policy: PolicyService,
    private readonly envPointers: EnvPointersService,
  ) {}

  @Scope('workflow:write')
  @Put(':workflowId')
  async update(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: WorkflowUpdateDto,
  ): Promise<Record<string, unknown>> {
    await this.authorize(req, workflowId, 'write');
    const wf = await this.reads.getWorkflowEntity(workflowId);
    if (body.name !== undefined) wf.name = body.name;
    if (body.description !== undefined) wf.description = body.description;
    await this.lifecycle.saveWorkflowMeta(wf);
    return this.reads.getWorkflow(workflowId);
  }

  @Scope('workflow:deploy')
  @Delete(':workflowId')
  async remove(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'manage');
    return this.lifecycle.deleteWorkflow(workflowId, principal.user.id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('workflow:write')
  @Post(':workflowId/commit')
  async commit(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: CommitDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    const { version, refWarnings, noChanges } = await this.versionsWrite.commit({
      workflowId,
      workflowJson: body.workflow_json ?? null,
      workflowIr: body.workflow_ir ?? null,
      branchName: body.branch,
      commitMessage: body.commit_message ?? null,
      author: body.author || principal.user.name,
      actorId: principal.user.id,
      principal,
      baseVersionId: body.base_version_id ?? null,
    });
    // The commit response deliberately omits the IR/diff/branch extras.
    return {
      ...versionResponse(version),
      workflow_ir: null,
      ir_diff: null,
      diff: null,
      branch_name: null,
      parent_id: null,
      ref_warnings: refWarnings,
      no_changes: noChanges ?? false,
    };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Post(':workflowId/versions/:versionNumber/rollback')
  async rollback(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Query('branch') branch?: string,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    return this.versionsWrite.rollback(workflowId, versionNumber, branch ?? null, principal.user.id);
  }

  /** Publish (Save ≠ Live): move the live pointer to a version, defaulting to the default branch's head. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Post(':workflowId/publish')
  async publish(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: PublishDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'deploy');
    return this.versionsWrite.publish(workflowId, body.version_number ?? null, principal.user.id);
  }

  /** Promote: point an ENVIRONMENT at a version (publish ≡ promote-to-prod). Org workflows also need an owner/admin, enforced in the service. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Post(':workflowId/promote')
  async promoteEnv(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: PromoteDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'deploy');
    return this.envPointers.promote(workflowId, body.environment, body.version_id, principal.user.id);
  }

  /** Layout patch: node moves are presentation, not history — the branch head is updated in place, no new version. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Scope('workflow:write')
  @Patch(':workflowId/layout')
  async patchLayout(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: { branch?: string; positions: Record<string, { x: number; y: number }> },
  ): Promise<{ updated: number }> {
    await this.authorize(req, workflowId, 'write');
    return this.versionsWrite.patchLayout(workflowId, body.branch, body.positions);
  }

  /** Un-promote: remove an environment's pointer. Prod IS allowed (the client confirms "workflow goes dark"). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Delete(':workflowId/pointers/:environmentId')
  async removePointer(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('environmentId') environmentId: string,
  ): Promise<{ removed: true; environment: string }> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'deploy');
    return this.envPointers.removePointer(workflowId, environmentId, principal.user.id);
  }

  /** Restore: instant live-pointer move to an older version — distinct from rollback, which appends a new one. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Post(':workflowId/restore')
  async restore(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: RestoreDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'deploy');
    return this.versionsWrite.restore(workflowId, body.version_number, principal.user.id);
  }

  private async authorize(req: Request, workflowId: string, action: PolicyAction): Promise<WorkflowEntity> {
    const wf = await this.reads.getWorkflowEntity(workflowId);
    const allowed = await this.policy.can(requirePrincipal(req), action, {
      orgId: wf.orgId,
      ownerUserId: wf.userId,
    });
    if (!allowed) throw new HttpException({ detail: 'Not authorised to access this workflow' }, 403);
    return wf;
  }
}
