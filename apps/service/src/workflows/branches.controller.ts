import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { PolicyService, type PolicyAction } from '../policy/policy.service';
import { BranchService } from './branch.service';
import { MergeOrchestrationService } from './merge-orchestration.service';
import { MergeResolutionDto } from './merge-resolution.dto';
import { branchView, WorkflowsReadService } from './workflows-read.service';
import { Scope } from '../auth/scope.decorator';

class CreateBranchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  from_version_id?: string;
}

class MergeBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  target_branch = 'main';

  /** In-app resolver decisions; when present the merge completes past conflicts. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MergeResolutionDto)
  resolutions?: MergeResolutionDto[];
}

class ProtectionDto {
  @IsBoolean()
  is_protected!: boolean;
}

/** Branch endpoints: list, create, protect, delete, merge. */
@Controller('api/workflows/:workflowId/branches')
@UseGuards(AuthGuard)
export class BranchesController {
  constructor(
    private readonly branches: BranchService,
    private readonly merges: MergeOrchestrationService,
    private readonly reads: WorkflowsReadService,
    private readonly policy: PolicyService,
  ) {}

  @Scope('workflow:read')
  @Get()
  async list(@Req() req: Request, @Param('workflowId') workflowId: string): Promise<Record<string, unknown>> {
    await this.authorize(req, workflowId, 'read');
    const branches = await this.branches.listBranches(workflowId);
    return { workflow_id: workflowId, branches: branches.map(branchView) };
  }

  /** The branch's editable head: its document plus the branches and live pointers to reason about it. */
  @Scope('workflow:read')
  @Get(':branchName/head')
  async head(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('branchName') branchName: string,
  ): Promise<Record<string, unknown>> {
    await this.authorize(req, workflowId, 'read');
    return this.reads.getBranchHead(workflowId, branchName);
  }

  @Scope('workflow:write')
  @Post()
  async create(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: CreateBranchDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    return branchView(
      await this.branches.createBranch(
        workflowId,
        body.name,
        body.from_version_id ?? null,
        principal.user.id,
      ),
    );
  }

  /** Opt-in branch protection toggle. */
  @Scope('workflow:deploy')
  @Patch(':branchName/protection')
  async setProtection(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('branchName') branchName: string,
    @Body() body: ProtectionDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'manage');
    const branch = await this.branches.setProtection(
      workflowId,
      branchName,
      body.is_protected,
      principal.user.id,
    );
    return { status: 'ok', name: branch.name, is_protected: branch.isProtected };
  }

  /** Delete a branch; its tag rows go with it. */
  @Scope('workflow:deploy')
  @Delete(':branchName')
  async remove(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('branchName') branchName: string,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    await this.branches.deleteBranch(workflowId, branchName, principal.user.id);
    return { status: 'deleted' };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Post(':branchName/merge')
  async merge(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('branchName') branchName: string,
    @Body() body: MergeBranchDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'merge');
    return this.merges.mergeAndCleanup(
      workflowId,
      branchName,
      body.target_branch,
      principal.user.id,
      body.resolutions,
    );
  }

  private async authorize(req: Request, workflowId: string, action: PolicyAction): Promise<void> {
    const wf = await this.reads.getWorkflowEntity(workflowId);
    const allowed = await this.policy.can(requirePrincipal(req), action, {
      orgId: wf.orgId,
      ownerUserId: wf.userId,
    });
    if (!allowed) throw new HttpException({ detail: 'Not authorised to access this workflow' }, 403);
  }
}
