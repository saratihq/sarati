import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { ReviewTestSummary } from '../../reviews/review-test.types';

/** One finished pre-merge test, kept by the two versions it tested — it outlives the review that ran it. */
@Entity('review_test_results')
export class ReviewTestResultEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  /** The review it was run from; null once that review is gone. */
  @Column({ name: 'review_id', type: 'uuid', nullable: true })
  reviewId!: string | null;

  @Column({ name: 'source_version_id', type: 'uuid' })
  sourceVersionId!: string;

  @Column({ name: 'target_version_id', type: 'uuid' })
  targetVersionId!: string;

  @Column({ type: 'varchar', length: 10 })
  verdict!: string;

  /** False when the target failed too — such a test neither shows nor rules out a new failure. */
  @Column({ type: 'boolean' })
  decisive!: boolean;

  @Column({ name: 'tested_at', type: 'timestamptz' })
  testedAt!: Date;

  @Column({ type: 'json' })
  summary!: ReviewTestSummary;
}
