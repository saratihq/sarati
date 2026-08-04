import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import type { EnvConfig } from '../config/env.config';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { PolicyService } from '../policy/policy.service';
import { DiffService, type WorkflowChangeSet } from '../workflows/diff.service';
import { WorkflowsReadService } from '../workflows/workflows-read.service';
import { MergeProbeService, type Mergeability } from './merge-probe.service';
import { ReviewsService } from './reviews.service';

/** What a reviewer is being asked to approve: the field-level ops, without their values. */
export interface ReviewDiffSummary {
  from_version_id: string;
  to_version_id: string;
  summary: string;
  node_changes: Array<{
    operation: string;
    node_id: string;
    node_name: string | null;
    path: string | null;
  }>;
  edge_changes: Array<{
    operation: string;
    source_node_id: string;
    source_port: number;
    target_node_id: string;
    target_port: number;
    port_type: string;
  }>;
  settings_changes: Array<{ path: string | null }>;
  renames: Array<{ old_name: string; new_name: string }>;
  renames_are_presentational: true;
}

/** An opened review, plus everything a human needs to act on it. */
export interface ReviewProposal {
  review_id: string;
  review_url: string;
  title: string;
  status: string;
  source_branch: string;
  target_branch: string;
  diff_summary: ReviewDiffSummary | null;
  mergeable: Mergeability;
}

export interface OpenReviewInput {
  workflowId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string | null;
}

/** The overview feed expands `?review=` in place; `?branch=` puts it in the source branch's stream. */
function reviewUrl(frontendUrl: string, workflowId: string, reviewId: string, branch: string): string {
  const query = new URLSearchParams({ branch, review: reviewId });
  return `${frontendUrl.replace(/\/$/, '')}/workflows/${workflowId}/overview?${query.toString()}`;
}

function summarize(changes: WorkflowChangeSet): ReviewDiffSummary {
  return {
    from_version_id: changes.from.version_id,
    to_version_id: changes.to.version_id,
    summary: changes.summary,
    node_changes: changes.node_changes.map((c) => ({
      operation: c.operation,
      node_id: c.node_id,
      node_name: c.node_name,
      path: c.path,
    })),
    edge_changes: changes.edge_changes.map((c) => ({ ...c })),
    settings_changes: changes.settings_changes.map((c) => ({ path: c.path })),
    renames: changes.renames.map((r) => ({ ...r })),
    renames_are_presentational: true,
  };
}

/**
 * Opening a review: authorize, create it, then describe what it proposes — the field-level change set
 * from the one content oracle (`DiffService`) and a read-only mergeability probe. Merging is a human
 * act and is deliberately absent (ADR 0052).
 */
@Injectable()
export class ReviewProposalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reviews: ReviewsService,
    private readonly diffs: DiffService,
    private readonly mergeProbe: MergeProbeService,
    private readonly reads: WorkflowsReadService,
    private readonly policy: PolicyService,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
  ) {}

  async open(principal: Principal, input: OpenReviewInput): Promise<ReviewProposal> {
    const wf = await this.reads.getWorkflowEntity(input.workflowId);
    const allowed = await this.policy.can(principal, 'write', {
      orgId: wf.orgId,
      ownerUserId: wf.userId,
    });
    if (!allowed) throw new DomainError('Not authorised to access this workflow', 403);

    const review = await this.reviews.createReview(
      input.workflowId,
      input.sourceBranch,
      input.targetBranch,
      input.title,
      principal.user.id,
      input.description,
    );

    const [diffSummary, mergeable] = await Promise.all([
      this.summarizeHeads(principal, input.workflowId, review.sourceBranchId, review.targetBranchId),
      this.mergeProbe.probe(review.sourceBranchId, review.targetBranchId),
    ]);

    const { frontendUrl } = this.config.get('env', { infer: true });
    return {
      review_id: review.id,
      review_url: reviewUrl(frontendUrl, input.workflowId, review.id, input.sourceBranch),
      title: review.title,
      status: review.status,
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      diff_summary: diffSummary,
      mergeable,
    };
  }

  /** Target head → source head: the base a reviewer holds against what the branch proposes. */
  private async summarizeHeads(
    principal: Principal,
    workflowId: string,
    sourceBranchId: string,
    targetBranchId: string,
  ): Promise<ReviewDiffSummary | null> {
    const em = this.dataSource.manager;
    const [source, target] = await Promise.all([
      em.findOne(WorkflowBranchEntity, { where: { id: sourceBranchId } }),
      em.findOne(WorkflowBranchEntity, { where: { id: targetBranchId } }),
    ]);
    if (!source?.headVersionId || !target?.headVersionId) return null;

    const changes = await this.diffs.getChangeSet(
      principal,
      workflowId,
      { id: target.headVersionId },
      { id: source.headVersionId },
    );
    return summarize(changes);
  }
}
