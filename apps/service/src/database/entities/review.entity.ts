import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { ReviewTestSummary } from '../../reviews/review-test.types';

/** Live enum reviewstatus (native PG enum). */
export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'merged' | 'closed';
/** Live enum approvaldecision. */
export type ApprovalDecision = 'approved' | 'rejected' | 'commented';

@Entity('workflow_reviews')
export class WorkflowReviewEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  @Column({ name: 'source_branch_id', type: 'uuid' })
  sourceBranchId!: string;

  @Column({ name: 'target_branch_id', type: 'uuid' })
  targetBranchId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: ['open', 'approved', 'rejected', 'merged', 'closed'],
    enumName: 'reviewstatus',
  })
  status!: ReviewStatus;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string;

  @Column({ name: 'merged_version_id', type: 'uuid', nullable: true })
  mergedVersionId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  /** Latest pre-merge "Test this branch" result (ADR 0015) — null until run. */
  @Column({ name: 'last_test', type: 'json', nullable: true })
  lastTest!: ReviewTestSummary | null;
}

@Entity('review_comments')
export class ReviewCommentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'review_id', type: 'uuid' })
  reviewId!: string;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  body!: string;

  /** Node-anchored comments (canvas). */
  @Column({ name: 'node_id', type: 'varchar', length: 50, nullable: true })
  nodeId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}

@Entity('review_approvals')
export class ReviewApprovalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'review_id', type: 'uuid' })
  reviewId!: string;

  @Column({ name: 'reviewer_id', type: 'uuid' })
  reviewerId!: string;

  @Column({
    type: 'enum',
    enum: ['approved', 'rejected', 'commented'],
    enumName: 'approvaldecision',
  })
  decision!: ApprovalDecision;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
