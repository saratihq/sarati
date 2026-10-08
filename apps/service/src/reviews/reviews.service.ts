import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { In, Not, type DataSource, type EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape, newId, now } from '../database/ids';
import {
  ReviewApprovalEntity,
  ReviewCommentEntity,
  WorkflowReviewEntity,
  type ApprovalDecision,
} from '../database/entities/review.entity';
import { OrgMemberEntity } from '../database/entities/organization.entity';
import { UserEntity } from '../database/entities/user.entity';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { EventsService } from '../events/events.service';
import type { MergeResolution } from '../ir/merge';
import { BranchService } from './../workflows/branch.service';

const PG_LOCK_NOT_AVAILABLE = '55P03';

/** Machine code a caller can branch on, rather than matching prose. */
export const REVIEW_ALREADY_OPEN = 'review_already_open';

/** Machine code for a review of a branch whose every change the target already has. */
export const NOTHING_TO_REVIEW = 'nothing_to_review';

/**
 * Reviews: one open review per (source, target) pair, status derived from approvals (any rejection is
 * sticky), merge under a FOR UPDATE NOWAIT lock, and every review id scoped to its workflow.
 */
@Injectable()
export class ReviewsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly branches: BranchService,
    private readonly events: EventsService,
  ) {}

  async createReview(
    workflowId: string,
    sourceBranchName: string,
    targetBranchName: string,
    title: string,
    authorId: string,
    description: string | null,
  ): Promise<WorkflowReviewEntity> {
    return this.dataSource.transaction(async (em) => {
      const source = await this.branches.getBranch(em, workflowId, sourceBranchName);
      const target = await this.branches.getBranch(em, workflowId, targetBranchName);

      const existing = await em.findOne(WorkflowReviewEntity, {
        where: { workflowId, sourceBranchId: source.id, targetBranchId: target.id, status: 'open' },
      });
      // Code and id ride the MESSAGE too: it is all the MCP surface forwards, and without them a
      // non-interactive caller retries forever instead of reading the review it already opened.
      if (existing) {
        throw new DomainError(
          `${REVIEW_ALREADY_OPEN}: an open review already exists for '${sourceBranchName}' → ` +
            `'${targetBranchName}' — review ${existing.id}. Read that review instead of opening another.`,
          409,
          { code: REVIEW_ALREADY_OPEN, review_id: existing.id },
        );
      }

      if (await this.targetHasSource(em, source, target)) {
        throw new DomainError(
          `'${sourceBranchName}' has no changes that '${targetBranchName}' doesn't already have — there is nothing to review.`,
          409,
          { code: NOTHING_TO_REVIEW },
        );
      }

      const review = em.create(WorkflowReviewEntity, {
        id: newId(),
        workflowId,
        sourceBranchId: source.id,
        targetBranchId: target.id,
        title,
        description,
        status: 'open',
        authorId,
        createdAt: now(),
        updatedAt: now(),
      });
      await em.save(WorkflowReviewEntity, review);

      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: authorId,
        type: 'review.created',
        subjectType: 'review',
        subjectId: review.id,
        payload: { source: sourceBranchName, target: targetBranchName },
      });
      return review;
    });
  }

  async listReviews(
    workflowId: string,
    statusFilter: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    const em = this.dataSource.manager;
    const where: Record<string, unknown> = { workflowId };
    if (statusFilter) where.status = statusFilter;
    const reviews = await em.find(WorkflowReviewEntity, {
      where,
      order: { createdAt: 'DESC' },
    });

    const out: Array<Record<string, unknown>> = [];
    for (const review of reviews) {
      out.push(await this.toSummary(review));
    }
    return out;
  }

  /** Fetch a review, enforcing that it belongs to the path's workflow. */
  async getReviewScoped(workflowId: string, reviewId: string): Promise<WorkflowReviewEntity> {
    if (!isIdShape(reviewId)) throw new DomainError(`Review ${reviewId} not found`, 404);
    const review = await this.dataSource.manager.findOne(WorkflowReviewEntity, { where: { id: reviewId } });
    if (!review || review.workflowId !== workflowId) {
      throw new DomainError(`Review ${reviewId} not found`, 404);
    }
    return review;
  }

  async getReviewDetail(workflowId: string, reviewId: string): Promise<Record<string, unknown>> {
    const review = await this.getReviewScoped(workflowId, reviewId);
    const em = this.dataSource.manager;
    const summary = await this.toSummary(review);

    const comments = await em.find(ReviewCommentEntity, {
      where: { reviewId: review.id },
      order: { createdAt: 'ASC' },
    });
    const approvals = await em.find(ReviewApprovalEntity, {
      where: { reviewId: review.id },
      order: { createdAt: 'ASC' },
    });
    const userIds = [...new Set([...comments.map((c) => c.authorId), ...approvals.map((a) => a.reviewerId)])];
    const users = userIds.length ? await em.find(UserEntity, { where: { id: In(userIds) } }) : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const [source, target] = await Promise.all([
      em.findOne(WorkflowBranchEntity, { where: { id: review.sourceBranchId } }),
      em.findOne(WorkflowBranchEntity, { where: { id: review.targetBranchId } }),
    ]);

    return {
      ...summary,
      source_head_version_id: source?.headVersionId ?? null,
      target_head_version_id: target?.headVersionId ?? null,
      up_to_date: source && target ? await this.targetHasSource(em, source, target) : false,
      merge_blocked_by_test: await this.mergeBlockedByTest(em, review),
      description: review.description,
      last_test: review.lastTest ?? null,
      comments: comments.map((c) => ({
        id: c.id,
        author_name: nameOf.get(c.authorId) ?? null,
        body: c.body,
        node_id: c.nodeId,
        created_at: c.createdAt?.toISOString() ?? null,
      })),
      approvals: approvals.map((a) => ({
        id: a.id,
        reviewer_name: nameOf.get(a.reviewerId) ?? null,
        decision: a.decision,
        comment: a.comment,
        created_at: a.createdAt?.toISOString() ?? null,
      })),
    };
  }

  async addComment(
    workflowId: string,
    reviewId: string,
    authorId: string,
    body: string,
    nodeId: string | null,
  ): Promise<ReviewCommentEntity> {
    return this.dataSource.transaction(async (em) => {
      const review = await this.getReviewScoped(workflowId, reviewId);
      if (review.status === 'merged' || review.status === 'closed') {
        throw new DomainError('Cannot comment on a closed or merged review');
      }
      const comment = em.create(ReviewCommentEntity, {
        id: newId(),
        reviewId: review.id,
        authorId,
        body,
        nodeId,
        createdAt: now(),
      });
      await em.save(ReviewCommentEntity, comment);
      return comment;
    });
  }

  async submitApproval(
    workflowId: string,
    reviewId: string,
    reviewerId: string,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ReviewApprovalEntity> {
    return this.dataSource.transaction(async (em) => {
      // Lock the review row so concurrent decisions can't race the derived status.
      const review = await em
        .createQueryBuilder(WorkflowReviewEntity, 'r')
        .setLock('pessimistic_write')
        .where('r.id = :reviewId AND r.workflow_id = :workflowId', { reviewId, workflowId })
        .getOne();
      if (!review) throw new DomainError(`Review ${reviewId} not found`, 404);
      if (review.status === 'merged' || review.status === 'closed') {
        throw new DomainError('Cannot approve a closed or merged review');
      }
      if (decision === 'approved' && review.authorId === reviewerId) {
        // Only where someone else could actually approve — a solo workspace must not deadlock.
        const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
        const others = wf?.orgId
          ? await em.count(OrgMemberEntity, { where: { orgId: wf.orgId, userId: Not(reviewerId) } })
          : 0;
        if (others > 0) {
          throw new DomainError('Your own review needs someone else to approve it', 409, {
            code: 'self_approval_blocked',
          });
        }
      }

      const approval = em.create(ReviewApprovalEntity, {
        id: newId(),
        reviewId: review.id,
        reviewerId,
        decision,
        comment,
        createdAt: now(),
      });
      await em.save(ReviewApprovalEntity, approval);

      const approvals = await em.find(ReviewApprovalEntity, { where: { reviewId: review.id } });
      const hasRejection = approvals.some((a) => a.decision === 'rejected');
      const hasApproval = approvals.some((a) => a.decision === 'approved');
      if (hasRejection) review.status = 'rejected';
      else if (hasApproval) review.status = 'approved';
      review.updatedAt = now();
      await em.save(WorkflowReviewEntity, review);

      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: reviewerId,
        type: `review.${decision}`,
        subjectType: 'review',
        subjectId: review.id,
      });
      return approval;
    });
  }

  async mergeReview(
    workflowId: string,
    reviewId: string,
    userId: string,
    resolutions?: MergeResolution[],
  ): Promise<Record<string, unknown>> {
    // ONE transaction: the NOWAIT review lock must be held ACROSS the merge.
    return this.dataSource
      .transaction(async (em) => {
        const review = await em
          .createQueryBuilder(WorkflowReviewEntity, 'r')
          .setLock('pessimistic_write')
          .setOnLocked('nowait')
          .where('r.id = :reviewId AND r.workflow_id = :workflowId', { reviewId, workflowId })
          .getOne();
        if (!review) throw new DomainError(`Review ${reviewId} not found`, 404);
        if (review.status === 'merged') throw new DomainError('Review is already merged');
        if (review.status === 'closed') throw new DomainError('Review is closed');

        const target = await em.findOne(WorkflowBranchEntity, { where: { id: review.targetBranchId } });
        const source = await em.findOne(WorkflowBranchEntity, { where: { id: review.sourceBranchId } });
        if (!target || !source) throw new DomainError('Review branches no longer exist');

        if (target.isProtected && review.status !== 'approved') {
          throw new DomainError('Target branch is protected — review must be approved before merging');
        }

        const result = await this.branches.mergeBranchIn(
          em,
          workflowId,
          source.name,
          target.name,
          userId,
          resolutions,
        );
        if (!result.success) {
          return {
            status: 'conflicts',
            conflicts: result.conflicts.map((c) => ({
              node_id: c.node_id,
              node_name: c.node_name,
              kind: c.kind,
              field_path: c.field_path,
              deleted_on: c.deleted_on ?? null,
              source_value: c.source_value,
              target_value: c.target_value,
              ancestor_value: c.ancestor_value,
            })),
          };
        }

        review.status = 'merged';
        review.mergedVersionId = result.mergedVersionId;
        review.updatedAt = now();
        await em.save(WorkflowReviewEntity, review);
        const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
        await this.events.emit(em, {
          orgId: wf?.orgId ?? null,
          actorUserId: userId,
          type: 'review.merged',
          subjectType: 'review',
          subjectId: review.id,
          payload: { merged_version_id: result.mergedVersionId },
        });
        return { status: 'merged', merged_version_id: result.mergedVersionId };
      })
      .catch((err: unknown) => {
        const code =
          (err as { driverError?: { code?: string }; code?: string }).driverError?.code ??
          (err as { code?: string }).code;
        if (code === PG_LOCK_NOT_AVAILABLE) {
          throw new DomainError('Another merge is in progress for this review — please retry shortly');
        }
        throw err;
      });
  }

  async closeReview(workflowId: string, reviewId: string, actorId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const review = await this.getReviewScoped(workflowId, reviewId);
      if (review.status === 'merged') throw new DomainError('Cannot close a merged review');
      review.status = 'closed';
      review.updatedAt = now();
      await em.save(WorkflowReviewEntity, review);
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: actorId,
        type: 'review.closed',
        subjectType: 'review',
        subjectId: review.id,
      });
    });
  }

  /** The review whose failing test refuses this merge right now, as the merge gate itself would answer. */
  private async mergeBlockedByTest(
    em: EntityManager,
    review: WorkflowReviewEntity,
  ): Promise<{ review_id: string; title: string } | null> {
    if (review.status === 'merged' || review.status === 'closed') return null;
    const blocking = await this.branches.testBlockingMerge(
      em,
      review.workflowId,
      review.sourceBranchId,
      review.targetBranchId,
    );
    return blocking ? { review_id: blocking.id, title: blocking.title } : null;
  }

  private async targetHasSource(
    em: EntityManager,
    source: WorkflowBranchEntity,
    target: WorkflowBranchEntity,
  ): Promise<boolean> {
    if (!source.headVersionId) return true;
    if (!target.headVersionId) return false;
    return this.branches.historyContains(em, target.headVersionId, source.headVersionId);
  }

  private async toSummary(review: WorkflowReviewEntity): Promise<Record<string, unknown>> {
    const em = this.dataSource.manager;
    const source = await em.findOne(WorkflowBranchEntity, { where: { id: review.sourceBranchId } });
    const target = await em.findOne(WorkflowBranchEntity, { where: { id: review.targetBranchId } });
    const author = await em.findOne(UserEntity, { where: { id: review.authorId } });
    const commentCount = await em.count(ReviewCommentEntity, { where: { reviewId: review.id } });
    const approvalCount = await em.count(ReviewApprovalEntity, {
      where: { reviewId: review.id, decision: 'approved' },
    });

    return {
      id: review.id,
      title: review.title,
      status: review.status,
      source_branch: source?.name ?? '',
      target_branch: target?.name ?? '',
      author_name: author?.name ?? null,
      created_at: review.createdAt?.toISOString() ?? null,
      updated_at: review.updatedAt?.toISOString() ?? null,
      comment_count: commentCount,
      approval_count: approvalCount,
    };
  }
}
