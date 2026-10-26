import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { ConnectionsService } from '../connections/connections.service';
import { planRunAs } from '../connections/run-as-account';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowReviewEntity } from '../database/entities/review.entity';
import { ReviewTestResultEntity } from '../database/entities/review-test-result.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import type { WorkflowEntity } from '../database/entities/workflow.entity';
import { now } from '../database/ids';
import { type NamedEnvironment, slotRefusalError, stepsRefusedIn } from '../environments/env-slot-preflight';
import { EnvironmentsService } from '../environments/environments.service';
import type { WorkflowIR } from '../ir/models';
import { isRunCancelled, RunsService } from '../runs/runs.service';
import { isDecisiveTest, isNewerTest } from '../workflows/branch.service';
import { EnvPointersService } from '../workflows/env-pointers.service';
import { lockWorkflowRow } from '../workflows/workflow-row-lock';
import { ReviewsService } from './reviews.service';
import { diffRunOutputs } from './run-output-diff';
import type {
  BlockedStep,
  ReviewTestReadiness,
  ReviewTestSide,
  ReviewTestSummary,
  TestVerdict,
} from './review-test.types';

/** Who is testing, and under which environment. */
export interface TestScope {
  principal: Principal;
  /** Named environment to run under (its slots supply every account); null = Default (the tester's own). */
  environmentId?: string | null;
}

/** What the caller chose for a test run. */
export interface TestBranchOptions extends TestScope {
  /** Explicit trigger payload; when absent, the workflow's latest completed run's trigger is used. */
  triggerPayload?: unknown;
}

interface ReviewHeads {
  source: WorkflowBranchEntity;
  target: WorkflowBranchEntity;
}

/** The outcome of running one side (base or head). */
interface SideRun {
  runId: string;
  status: 'completed' | 'error';
  outputs: Record<string, unknown> | null;
  error: string | null;
  cancelled: boolean;
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
    private readonly connections: ConnectionsService,
    private readonly envPointers: EnvPointersService,
    private readonly environments: EnvironmentsService,
  ) {}

  /** The branch head's steps a test would refuse for want of an account — the run-as rule, dry, for this tester and environment. */
  async readiness(workflowId: string, reviewId: string, scope: TestScope): Promise<ReviewTestReadiness> {
    const wf = await this.runs.runnableWorkflow(workflowId, scope.principal.activeOrgId);
    const review = await this.reviews.getReviewScoped(workflowId, reviewId);
    const em = this.dataSource.manager;
    const environment = await this.environmentOf(em, wf, scope.environmentId);
    const headIr = await this.headIr(em, (await this.headsOf(em, review)).source);
    const plan = await planRunAs(
      headIr,
      {
        externalUserId: scope.principal.user.id,
        environmentId: environment?.id ?? null,
        environment: environment?.name ?? null,
      },
      this.connections,
    );
    const blocked = plan.flatMap((step): BlockedStep[] =>
      step.decision.kind === 'refused'
        ? [
            {
              node_id: step.node_id,
              node_name: step.node_name,
              app: step.app,
              reason: step.decision.reason,
              message: step.decision.message,
            },
          ]
        : [],
    );
    return { environment, blocked };
  }

  async testBranch(
    workflowId: string,
    reviewId: string,
    opts: TestBranchOptions,
  ): Promise<ReviewTestSummary> {
    const wf = await this.runs.runnableWorkflow(workflowId, opts.principal.activeOrgId);
    const review = await this.reviews.getReviewScoped(workflowId, reviewId);
    if (review.status === 'merged' || review.status === 'closed') {
      throw new DomainError('Cannot test a closed or merged review');
    }
    const em = this.dataSource.manager;
    const environment = await this.environmentOf(em, wf, opts.environmentId);
    if (environment) {
      await this.envPointers.assertMayPromote(em, wf.orgId, environment.name, opts.principal, 'test');
    }
    const { source, target } = await this.headsOf(em, review);

    const headIr = await this.headIr(em, source); // source branch head — the change under review
    const baseIr = await this.headIr(em, target); // target branch head — the baseline to compare against
    if (environment) {
      const refused = await stepsRefusedIn(headIr, environment, this.connections);
      if (refused.length > 0) {
        throw slotRefusalError(environment, refused, ', or test on Default (your connections)');
      }
    }
    const payload =
      opts.triggerPayload !== undefined ? opts.triggerPayload : await this.defaultPayload(opts, workflowId);

    const [base, head] = await Promise.all([
      this.runSide(baseIr, payload, wf, reviewId, opts, environment),
      this.runSide(headIr, payload, wf, reviewId, opts, environment),
    ]);
    // A cancelled run neither passed nor failed, so the test has no result to keep or to gate a merge on.
    if (base.cancelled || head.cancelled) {
      throw new DomainError('The test was cancelled before it finished, so it has no result', 409, {
        code: 'test_cancelled',
      });
    }

    const regression =
      base.outputs && head.outputs
        ? diffRunOutputs(base.outputs, head.outputs)
        : { changed: [], added: [], removed: [] };
    // RED only for a NEW failure — both-errored is pre-existing and must not block.
    const verdict: TestVerdict = head.status === 'error' && base.status !== 'error' ? 'red' : 'green';

    const summary: ReviewTestSummary = {
      verdict,
      tested_at: new Date().toISOString(),
      environment_id: environment?.id ?? null,
      source_version_id: source.headVersionId ?? null,
      target_version_id: target.headVersionId ?? null,
      base: sideSummary(base),
      head: sideSummary(head),
      regression,
    };

    await this.storeTest(workflowId, review.id, summary);
    return summary;
  }

  /** Keep a finished test by its versions — even once its review is gone — and show it there if newest. */
  async storeTest(workflowId: string, reviewId: string, summary: ReviewTestSummary): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      if (!(await lockWorkflowRow(em, workflowId))) return;
      const review = await em.findOne(WorkflowReviewEntity, {
        where: { id: reviewId },
        lock: { mode: 'pessimistic_write' },
      });
      if (summary.source_version_id && summary.target_version_id) {
        const result = new ReviewTestResultEntity();
        result.id = randomUUID();
        result.workflowId = workflowId;
        result.reviewId = review ? review.id : null;
        result.sourceVersionId = summary.source_version_id;
        result.targetVersionId = summary.target_version_id;
        result.verdict = summary.verdict;
        result.decisive = isDecisiveTest(summary);
        result.testedAt = new Date(summary.tested_at);
        result.summary = summary;
        await em.save(ReviewTestResultEntity, result);
      }
      if (!review || (review.lastTest && !isNewerTest(summary, review.lastTest))) return;
      review.lastTest = summary;
      review.updatedAt = now();
      await em.save(WorkflowReviewEntity, review);
    });
  }

  // SECURITY (cross-tenant): a caller-supplied environment resolves to real connections, so one outside the workflow's org is a 404.
  private async environmentOf(
    em: EntityManager,
    wf: WorkflowEntity,
    environmentId: string | null | undefined,
  ): Promise<NamedEnvironment | null> {
    if (!environmentId) return null;
    if (!wf.orgId) throw new DomainError('Environment not found', 404);
    const { id, name } = await this.environments.byIdForOrg(em, wf.orgId, environmentId);
    return { id, name };
  }

  private async headsOf(em: EntityManager, review: WorkflowReviewEntity): Promise<ReviewHeads> {
    const source = await em.findOne(WorkflowBranchEntity, { where: { id: review.sourceBranchId } });
    const target = await em.findOne(WorkflowBranchEntity, { where: { id: review.targetBranchId } });
    if (!source || !target) throw new DomainError('Review branches no longer exist');
    return { source, target };
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
    wf: WorkflowEntity,
    reviewId: string,
    opts: TestBranchOptions,
    environment: NamedEnvironment | null,
  ): Promise<SideRun> {
    const runId = randomUUID();
    try {
      const result = await this.runs.runFromIr(ir, {
        externalUserId: opts.principal.user.id,
        activeOrgId: opts.principal.activeOrgId,
        runId,
        workflowId: wf.id,
        source: 'review_test',
        reviewId,
        environment: environment?.name ?? null,
        environmentId: environment?.id ?? null,
        orgId: wf.orgId,
        initialScope: payload !== undefined ? { trigger: payload } : undefined,
      });
      return { runId, status: 'completed', outputs: result.outputs, error: null, cancelled: false };
    } catch (err) {
      return {
        runId,
        status: 'error',
        outputs: null,
        error: errorMessage(err),
        cancelled: isRunCancelled(err),
      };
    }
  }

  /** Default payload: the workflow's latest completed run's trigger, else `{}`. */
  private async defaultPayload(opts: TestBranchOptions, workflowId: string): Promise<unknown> {
    const latest = await this.runs.latestRunOutputs(opts.principal.user.id, workflowId);
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
