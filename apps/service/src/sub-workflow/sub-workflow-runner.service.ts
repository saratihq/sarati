import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { isIdShape } from '../database/ids';
import { EnvironmentEntity } from '../database/entities/environment.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import type { WorkflowIR } from '../ir/models';
import { RunsService } from '../runs/runs.service';
import type { AgentSubWorkflowContext, AgentSubWorkflowRunner, SubWorkflowToolCall } from '../runtime/agent';
import { MAX_SUB_WORKFLOW_DEPTH, MAX_SUB_WORKFLOW_INVOCATIONS } from '../runtime/base-plan-interpreter';
import type { DagPlan } from '../runtime/dag-plan';
import { RuntimeCompiler } from '../runtime/runtime-compiler';
import { extractChatReply } from '../runtime/terminal-output';
import { EnvPointersService } from '../workflows/env-pointers.service';

/**
 * Sub-workflow-as-tool runner (ADR 0045 §3): binds the interpreter's `AgentSubWorkflowRunner` seam
 * so an agent can call another workflow as a tool. It sits ABOVE the interpreter, so it wires itself
 * in through the RunsService setter — a constructor dependency would be a module cycle.
 *
 * The locked design: the sub-workflow's LIVE version for the CALLER's environment; RUN-AS-CALLER, so
 * its steps resolve connections through the parent's env slots and never the sub-workflow owner's;
 * nested inside the parent's durable run, never a separate top-level run; bounded by run-time depth
 * AND breadth guards alongside the compiler's author-time self-reference check; and the result is
 * the terminal-node output via {@link extractChatReply}. Any failure is an honest
 * {@link DomainError} the agent loop feeds back as a tool error.
 */
@Injectable()
export class SubWorkflowRunnerService implements AgentSubWorkflowRunner, OnModuleInit {
  private readonly logger = new Logger(SubWorkflowRunnerService.name);

  constructor(
    private readonly runs: RunsService,
    private readonly compiler: RuntimeCompiler,
    private readonly envPointers: EnvPointersService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.runs.bindSubWorkflowRunner(this);
  }

  async run(call: SubWorkflowToolCall, ctx: AgentSubWorkflowContext): Promise<unknown> {
    // DEPTH guard: every hop increments regardless of which workflow, bounding a deep chain
    // AND an indirect cycle A→B→A. Resets per branch.
    const depth = ctx.depth + 1;
    if (depth > MAX_SUB_WORKFLOW_DEPTH) {
      throw new DomainError(
        `Maximum sub-workflow call depth (${MAX_SUB_WORKFLOW_DEPTH}) exceeded — workflows are nested too deep (a call chain or cycle). Simplify the chain.`,
      );
    }
    // BREADTH guard: ONE budget shared across the whole tree, since depth can't bound fan-out.
    // Check-then-decrement with NO await between, so concurrent branches can't both slip past.
    if (ctx.budget.remaining <= 0) {
      throw new DomainError(
        `Sub-workflow invocation budget (${MAX_SUB_WORKFLOW_INVOCATIONS}) exhausted for this run — too many sub-workflow calls in one run. Reduce how often the agents call sub-workflows.`,
      );
    }
    ctx.budget.remaining -= 1;

    const em = this.dataSource.manager;
    const wf = await this.resolveCallableWorkflow(em, call.workflowId, ctx);

    // Resolve the LIVE version for the CALLER's env (ADR 0014 reuse) + load its document.
    const versionId = await this.resolveLiveVersion(em, wf, ctx);
    if (!versionId) {
      throw new DomainError(
        `Sub-workflow "${wf.name}" has no live version in the "${ctx.environment ?? 'production'}" environment — promote it there first.`,
      );
    }
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: versionId } });
    const ir = version?.workflowIr as unknown as WorkflowIR | undefined;
    if (!ir) throw new DomainError(`Sub-workflow "${wf.name}" has no runnable version document.`);

    // Compile with the self-ref guard armed on the SUB-workflow's own id — the run-time
    // backstop for a self-reference already stored in a version document.
    let plan: DagPlan;
    try {
      plan = this.compiler.compile(ir, wf.id);
    } catch (err) {
      throw new DomainError(`Sub-workflow "${wf.name}" can't run: ${errorMessage(err)}`);
    }

    // A tool call runs synchronously inside ONE durable step, so it can't park for a human:
    // a `wait_for_event` has no waiter to resume and would hang to timeout. Reject up front.
    if (planHasWaitForEvent(plan)) {
      throw new DomainError(
        `Sub-workflow "${wf.name}" can't be used as an agent tool — it pauses for human input (a "wait for event" step), which a tool call can't resume. Remove the wait, or call it another way.`,
      );
    }

    // Audit trail for a side-effecting shared-slot feature: what ran, which version, and as whom.
    this.logger.log(
      `sub-workflow tool → "${wf.name}" (${wf.id}) v=${versionId} depth=${depth} ` +
        `as user=${ctx.externalUserId} env=${ctx.environment ?? 'default'} budget_left=${ctx.budget.remaining}`,
    );
    const result = await this.runs.runSubWorkflowNested(plan, {
      externalUserId: ctx.externalUserId,
      // Deterministic sub-run id, stable across a DBOS crash-replay, so a re-run re-issues the SAME
      // step idempotency keys — the SDK rail dedupes on them (ADR 0040), Composio does not.
      runId: `${ctx.parentRunId}:${ctx.callKey}`,
      // The model's structured tool input IS the sub-workflow's firing event (`{{trigger.<field>}}`).
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
    ctx: AgentSubWorkflowContext,
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

  /**
   * The sub-workflow's LIVE version for the CALLER's environment (ADR 0014 reuse, no new selector);
   * `null` means not promoted there, which the caller turns into an honest tool error.
   */
  private async resolveLiveVersion(
    em: EntityManager,
    wf: WorkflowEntity,
    ctx: AgentSubWorkflowContext,
  ): Promise<string | null> {
    if (ctx.environmentId) {
      const env = await em.findOne(EnvironmentEntity, { where: { id: ctx.environmentId } });
      if (!env) return null;
      return this.envPointers.resolveVersionIdForEnv(em, wf, env);
    }
    return this.envPointers.resolveVersionId(em, wf, null);
  }
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
