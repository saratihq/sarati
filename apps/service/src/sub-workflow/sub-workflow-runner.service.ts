import { createHash } from 'node:crypto';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { isIdShape } from '../database/ids';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import type { WorkflowIR } from '../ir/models';
import { RunsService } from '../runs/runs.service';
import { MAX_SUB_WORKFLOW_DEPTH } from '../runtime/base-plan-interpreter';
import type { SubWorkflowCall, SubWorkflowContext, SubWorkflowRunner } from '../runtime/sub-workflow-runner';
import type { DagPlan } from '../runtime/dag-plan';
import { RuntimeCompiler } from '../runtime/runtime-compiler';
import { extractChatReply } from '../runtime/terminal-output';
import { contractOfDocument } from '../runtime/workflow-tool-contract';
import { WorkflowToolContractService } from '../workflows/workflow-tool-contract.service';
import { EnvPointersService } from '../workflows/env-pointers.service';

/**
 * The ONE way a workflow runs inside another (ADR 0045 §3, ADR 0062) — an AI agent picking it as a
 * tool and an authored `orchestr:call_workflow` step arrive here alike. It sits ABOVE the
 * interpreter, so it wires itself in through the RunsService setter — a constructor dependency
 * would be a module cycle.
 *
 * The locked design: the target's LIVE version for the CALLER's environment; callable only if it
 * DECLARES itself so; RUN-AS-CALLER, so its steps resolve connections through the parent's env
 * slots and never the target owner's; executed nested inside the parent's durable run, while
 * recording as a run in its own right; bounded by the run-time depth guard alongside the compiler's
 * author-time self-reference check; and the result is the terminal-node output via
 * {@link extractChatReply}. Any failure is an honest {@link DomainError} the caller surfaces.
 */
@Injectable()
export class SubWorkflowRunnerService implements SubWorkflowRunner, OnModuleInit {
  private readonly logger = new Logger(SubWorkflowRunnerService.name);

  constructor(
    private readonly runs: RunsService,
    private readonly compiler: RuntimeCompiler,
    private readonly envPointers: EnvPointersService,
    private readonly toolContracts: WorkflowToolContractService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.runs.bindSubWorkflowRunner(this);
    this.runs.bindWorkflowToolCatalog(this.toolContracts);
  }

  async run(call: SubWorkflowCall, ctx: SubWorkflowContext): Promise<unknown> {
    // DEPTH guard: every hop increments regardless of which workflow, bounding a deep chain
    // AND an indirect cycle A→B→A. Resets per branch.
    const depth = ctx.depth + 1;
    if (depth > MAX_SUB_WORKFLOW_DEPTH) {
      throw new DomainError(
        `Maximum sub-workflow call depth (${MAX_SUB_WORKFLOW_DEPTH}) exceeded — workflows are nested too deep (a call chain or cycle). Simplify the chain.`,
      );
    }
    // The BREADTH guard is charged by the agent path before it gets here (ADR 0062); the counter
    // rides along so every agent nested under this run shares one budget.
    const em = this.dataSource.manager;
    const wf = await this.resolveCallableWorkflow(em, call.workflowId, ctx);

    // Resolve the LIVE version for the CALLER's env (ADR 0014 reuse) + load its document.
    const versionId = await this.envPointers.resolveVersionIdForCaller(em, wf, ctx.environmentId);
    if (!versionId) {
      throw new DomainError(
        `Sub-workflow "${wf.name}" has no live version in the "${ctx.environment ?? 'production'}" environment — promote it there first.`,
      );
    }
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: versionId } });
    const ir = version?.workflowIr as unknown as WorkflowIR | undefined;
    if (!ir) throw new DomainError(`Sub-workflow "${wf.name}" has no runnable version document.`);

    // Being callable is OPT-IN, and asserted against the document about to run rather than a
    // separately-resolved one — the same requirement MCP `invoke` makes of an external caller
    // (ADR 0053 §1, ADR 0062). A workflow nobody declared callable is not one to call by accident.
    if (!contractOfDocument(ir, wf.name)) {
      throw new DomainError(
        `Sub-workflow "${wf.name}" doesn't declare itself callable, so it can't be called from another workflow. ` +
          'Open it, set its trigger to "Called by another workflow", and give it a name and description.',
      );
    }

    // Compile with the self-ref guard armed on the SUB-workflow's own id — the run-time
    // backstop for a self-reference already stored in a version document.
    let plan: DagPlan;
    try {
      plan = this.compiler.compile(ir, wf.id);
    } catch (err) {
      throw new DomainError(`Sub-workflow "${wf.name}" can't run: ${errorMessage(err)}`);
    }

    // The call runs synchronously inside ONE durable step of the caller, so it can't park for a
    // human: a `wait_for_event` has no waiter to resume and would hang to timeout. Reject up front.
    if (planHasWaitForEvent(plan)) {
      throw new DomainError(
        `Sub-workflow "${wf.name}" can't be called from another workflow — it pauses for human input (a "wait for event" step), which the calling step can't resume. Remove the wait, or call it another way.`,
      );
    }

    // Audit trail for a side-effecting shared-slot feature: what ran, which version, and as whom.
    this.logger.log(
      `sub-workflow → "${wf.name}" (${wf.id}) v=${versionId} depth=${depth} ` +
        `as user=${ctx.externalUserId} env=${ctx.environment ?? 'default'} budget_left=${ctx.budget.remaining}`,
    );
    const result = await this.runs.runSubWorkflowNested(plan, {
      externalUserId: ctx.externalUserId,
      runId: childRunId(ctx.parentRunId, ctx.callKey),
      workflowId: wf.id,
      workflowVersionId: versionId,
      parentRunId: ctx.parentRunId,
      parentStepKey: ctx.callKey,
      // The caller's structured input IS the sub-workflow's firing event (`{{trigger.<field>}}`).
      initialScope: { trigger: call.input },
      environment: ctx.environment,
      environmentId: ctx.environmentId,
      orgId: ctx.orgId,
      dryRun: ctx.dryRun,
      subWorkflowDepth: depth,
      subWorkflowBudget: ctx.budget, // the SAME counter — shared by reference across the whole tree
    });

    // The tool result is the terminal-node output, by the SAME rule the chat intake uses —
    // never the whole scope.
    return extractChatReply(ir, result);
  }

  /**
   * Load and authorize the target: a caller may only call a workflow in their OWN org or one they
   * OWN. Anything else must be indistinguishable from missing — no cross-org existence leak.
   */
  private async resolveCallableWorkflow(
    em: EntityManager,
    workflowId: string,
    ctx: SubWorkflowContext,
  ): Promise<WorkflowEntity> {
    const notFound = new DomainError(`Sub-workflow "${workflowId}" not found or not accessible.`);
    const id = typeof workflowId === 'string' ? workflowId.trim() : '';
    if (!isIdShape(id)) throw notFound;
    const wf = await em.findOne(WorkflowEntity, { where: { id } });
    if (!wf) throw notFound;
    const sameOrg = ctx.orgId !== null && wf.orgId === ctx.orgId;
    // Deliberately BROADER than `assertWorkflowRunnable` (org-only): a caller may call their OWN
    // workflow from an org-less run. Safe because the sub-run executes AS the caller, granting no
    // access they don't already have.
    const owned = wf.userId !== null && wf.userId === ctx.externalUserId;
    if (!sameOrg && !owned) throw notFound;
    return wf;
  }
}

/**
 * The child run's id: deterministic, so a crash-replay reuses the row AND re-issues the same step
 * idempotency keys (the SDK rail dedupes on them per ADR 0040; Composio does not) — and bounded,
 * because chaining parent id onto call key would outgrow the column a few levels down. What the
 * chain WAS is recorded in `parent_run_id`/`parent_step_key`, not encoded in the id.
 */
function childRunId(parentRunId: string, callKey: string): string {
  const digest = createHash('sha256').update(`${parentRunId} ${callKey}`).digest('hex');
  return `sub_${digest.slice(0, 32)}`;
}

/**
 * True if the plan or any nested sub-plan contains a `wait_for_event` node. A sub-workflow's OWN
 * sub-workflow tools are NOT scanned — each is guarded when that nested runner call runs.
 */
function planHasWaitForEvent(plan: DagPlan): boolean {
  for (const node of plan.nodes) {
    if (node.kind === 'waitForEvent') return true;
    const nested: DagPlan[] = [];
    if ('body' in node && node.body) nested.push(node.body);
    if ('branches' in node && Array.isArray(node.branches)) nested.push(...node.branches);
    if ('onErrorBranch' in node && node.onErrorBranch) nested.push(node.onErrorBranch);
    if (nested.some(planHasWaitForEvent)) return true;
  }
  return false;
}
