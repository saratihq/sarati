import { Body, Controller, Get, HttpException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import type { ApprovalDecision } from '../database/entities/review.entity';
import { PolicyService, type PolicyAction } from '../policy/policy.service';
import { MergeResolutionDto } from '../workflows/merge-resolution.dto';
import { WorkflowsReadService } from '../workflows/workflows-read.service';
import { ReviewTestService } from './review-test.service';
import { ReviewsService } from './reviews.service';
import { Scope } from '../auth/scope.decorator';

class CreateReviewDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  source_branch!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  target_branch = 'main';

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class CommentDto {
  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsString()
  node_id?: string;
}

class ApprovalDto {
  @IsIn(['approved', 'rejected', 'commented'])
  decision!: ApprovalDecision;

  @IsOptional()
  @IsString()
  comment?: string;
}

class MergeReviewDto {
  /** In-app resolver decisions; when present the merge completes past conflicts. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MergeResolutionDto)
  resolutions?: MergeResolutionDto[];
}

class TestBranchDto {
  /** Named environment to run under; omit for Default (personal connections). */
  @IsOptional()
  @IsString()
  environment_id?: string;

  @IsOptional()
  @IsString()
  environment_name?: string;

  /** Explicit trigger payload; omit to use the workflow's latest run's trigger. */
  @IsOptional()
  trigger_payload?: unknown;
}

/** Review endpoints; every review id is scoped to the path's workflow. */
@Controller('api/workflows/:workflowId/reviews')
@UseGuards(AuthGuard)
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly reviewTest: ReviewTestService,
    private readonly reads: WorkflowsReadService,
    private readonly policy: PolicyService,
  ) {}

  @Scope('workflow:read')
  @Get()
  async list(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Query('status') status?: string,
  ): Promise<Record<string, unknown>> {
    await this.authorize(req, workflowId, 'read');
    return { workflow_id: workflowId, reviews: await this.reviews.listReviews(workflowId, status ?? null) };
  }

  @Scope('workflow:write')
  @Post()
  async create(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: CreateReviewDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    const review = await this.reviews.createReview(
      workflowId,
      body.source_branch,
      body.target_branch,
      body.title,
      principal.user.id,
      body.description ?? null,
    );
    return {
      id: review.id,
      title: review.title,
      status: review.status,
      source_branch: body.source_branch,
      target_branch: body.target_branch,
      author_name: principal.user.name,
      created_at: review.createdAt?.toISOString() ?? null,
    };
  }

  @Scope('workflow:read')
  @Get(':reviewId')
  async detail(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('reviewId') reviewId: string,
  ): Promise<Record<string, unknown>> {
    await this.authorize(req, workflowId, 'read');
    return this.reviews.getReviewDetail(workflowId, reviewId);
  }

  @Scope('workflow:write')
  @Post(':reviewId/comments')
  async comment(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: CommentDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    const comment = await this.reviews.addComment(
      workflowId,
      reviewId,
      principal.user.id,
      body.body,
      body.node_id ?? null,
    );
    return {
      id: comment.id,
      author_name: principal.user.name,
      body: comment.body,
      node_id: comment.nodeId,
      created_at: comment.createdAt?.toISOString() ?? null,
    };
  }

  @Scope('workflow:deploy')
  @Post(':reviewId/approve')
  async approve(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: ApprovalDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    const approval = await this.reviews.submitApproval(
      workflowId,
      reviewId,
      principal.user.id,
      body.decision,
      body.comment ?? null,
    );
    return {
      id: approval.id,
      reviewer_name: principal.user.name,
      decision: approval.decision,
      comment: approval.comment,
      created_at: approval.createdAt?.toISOString() ?? null,
    };
  }

  @Scope('workflow:deploy')
  @Post(':reviewId/merge')
  async merge(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: MergeReviewDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'merge');
    const result = await this.reviews.mergeReview(workflowId, reviewId, principal.user.id, body.resolutions);
    if (result.status === 'conflicts') {
      return { status: 'conflicts', merged_version_id: null, conflicts: result.conflicts, cleaned_up: null };
    }
    return {
      status: 'merged',
      merged_version_id: result.merged_version_id ?? null,
      conflicts: [],
      cleaned_up: null,
    };
  }

  /** Pre-merge "Test this branch" (ADR 0015): dual-run both heads on one payload. REALLY executes — live effects can fire. */
  @Scope('run:execute')
  @Post(':reviewId/test')
  async test(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: TestBranchDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    const summary = await this.reviewTest.testBranch(workflowId, reviewId, {
      userId: principal.user.id,
      activeOrgId: principal.activeOrgId,
      environmentId: body.environment_id ?? null,
      environmentName: body.environment_name ?? null,
      triggerPayload: body.trigger_payload,
    });
    return { ...summary };
  }

  @Scope('workflow:write')
  @Post(':reviewId/close')
  async close(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Param('reviewId') reviewId: string,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.authorize(req, workflowId, 'write');
    await this.reviews.closeReview(workflowId, reviewId, principal.user.id);
    return { status: 'closed' };
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
