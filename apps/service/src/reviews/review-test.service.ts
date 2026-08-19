import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowReviewEntity } from '../database/entities/review.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { now } from '../database/ids';
import type { WorkflowIR } from '../ir/models';
import { RunsService } from '../runs/runs.service';
import { ReviewsService } from './reviews.service';
import { diffRunOutputs } from './run-output-diff';
import type { ReviewTestSide, ReviewTestSummary, TestVerdict } from './review-test.types';

/** What the caller chose for a test run. */
export interface TestBranchOptions {
  userId: string;
  activeOrgId: string | null;
  /** Named environment to run under (its slots resolve connections); null = Default (personal). */
  environmentId?: string | null;
  environmentName?: string | null;
  /** Explicit trigger payload; when absent, the workflow's latest completed run's trigger is used. */
  triggerPayload?: unknown;
}

/** The outcome of running one side (base or head). */
interface SideRun {
  runId: string;
  status: 'completed' | 'error';
  outputs: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Pre-merge "Test this branch": runs both branch heads on the SAME payload and stamps the
 * verdict on `review.last_test` (red iff the head fails where the baseline did not). REALLY executes.
 */
@Injectable()
export class ReviewTestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly runs: RunsService,
    private readonly reviews: ReviewsService,
  ) {}

  async testBranch(
    workflowId: string,
    reviewId: string,
    opts: TestBranchOptions,
  ): Promise<ReviewTestSummary> {
    const review = await this.reviews.getReviewScoped(workflowId, reviewId);
    if (review.status === 'merged' || review.status === 'closed') {
      throw new DomainError('Cannot test a closed or merged review');
    }
    // SECURITY (cross-tenant): the caller-supplied environment_id resolves to real connections,
    // so it MUST be proven to belong to the principal's active org; anything else is a 404.
    if (opts.environmentId) {
      const owned: unknown[] = await this.dataSource.query(
        `SELECT 1 FROM environments WHERE id = $1 AND org_id = $2`,
        [opts.environmentId, opts.activeOrgId ?? null],
      );
      if (owned.length === 0) throw new DomainError('Environment not found', 404);
    }
    const em = this.dataSource.manager;
    const source = await em.findOne(WorkflowBranchEntity, { where: { id: review.sourceBranchId } });
    const target = await em.findOne(WorkflowBranchEntity, { where: { id: review.targetBranchId } });
    if (!source || !target) throw new DomainError('Review branches no longer exist');

    const headIr = await this.headIr(em, source); // source branch head — the change under review
    const baseIr = await this.headIr(em, target); // target branch head — the baseline to compare against
    const payload =
      opts.triggerPayload !== undefined ? opts.triggerPayload : await this.defaultPayload(opts, workflowId);

    const [base, head] = await Promise.all([
      this.runSide(baseIr, payload, workflowId, reviewId, opts),
      this.runSide(headIr, payload, workflowId, reviewId, opts),
    ]);

    const regression =
      base.outputs && head.outputs
        ? diffRunOutputs(base.outputs, head.outputs)
        : { changed: [], added: [], removed: [] };
    // RED only for a NEW failure — both-errored is pre-existing and must not block.
    const verdict: TestVerdict = head.status === 'error' && base.status !== 'error' ? 'red' : 'green';

    const summary: ReviewTestSummary = {
      verdict,
      tested_at: new Date().toISOString(),
      environment_id: opts.environmentId ?? null,
      source_version_id: source.headVersionId ?? null,
      target_version_id: target.headVersionId ?? null,
      base: sideSummary(base),
      head: sideSummary(head),
      regression,
    };

    review.lastTest = summary;
    review.updatedAt = now();
    await em.save(WorkflowReviewEntity, review);
    return summary;
  }

  /** The stored head IR (native workflow doc) of a branch. */
  private async headIr(em: EntityManager, branch: WorkflowBranchEntity): Promise<WorkflowIR> {
    if (!branch.headVersionId) {
      throw new DomainError(`Branch '${branch.name}' has no versions to test`);
    }
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: branch.headVersionId } });
    if (!version) throw new DomainError(`Head version of '${branch.name}' not found`);
    return version.workflowJson as unknown as WorkflowIR;
  }

  /** Run one side, catching a step failure so `Promise.all` sees a result rather than a rejection. */
  private async runSide(
    ir: WorkflowIR,
    payload: unknown,
    workflowId: string,
    reviewId: string,
    opts: TestBranchOptions,
  ): Promise<SideRun> {
    const runId = randomUUID();
    try {
      const result = await this.runs.runFromIr(ir, {
        externalUserId: opts.userId,
        activeOrgId: opts.activeOrgId,
        runId,
        workflowId,
        source: 'review_test',
        reviewId,
        environment: opts.environmentName ?? null,
        environmentId: opts.environmentId ?? null,
        orgId: opts.activeOrgId,
        initialScope: payload !== undefined ? { trigger: payload } : undefined,
      });
      return { runId, status: 'completed', outputs: result.outputs, error: null };
    } catch (err) {
      return {
        runId,
        status: 'error',
        outputs: null,
        error: errorMessage(err),
      };
    }
  }

  /** Default payload: the workflow's latest completed run's trigger, else `{}`. */
  private async defaultPayload(opts: TestBranchOptions, workflowId: string): Promise<unknown> {
    const latest = await this.runs.latestRunOutputs(opts.userId, workflowId);
    const outputs = latest && typeof latest === 'object' ? (latest as { outputs?: unknown }).outputs : null;
    if (outputs && typeof outputs === 'object' && 'trigger' in outputs) {
      return (outputs as { trigger?: unknown }).trigger ?? {};
    }
    return {};
  }
}

function sideSummary(run: SideRun): ReviewTestSide {
  return { run_id: run.runId, status: run.status, error: run.error };
}
