import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import type { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { EnvironmentsService } from '../environments/environments.service';
import type { WorkflowIR } from '../ir/models';
import { RunsService } from '../runs/runs.service';
import type { RunOutcome } from '../runtime/run-plan';
import { extractChatReply } from '../runtime/terminal-output';
import { AGENT_TOOL_PUBLIC, contractOfDocument } from '../runtime/workflow-tool-contract';
import { EnvPointersService, PROD_ENV } from './env-pointers.service';
import { WorkflowsReadService } from './workflows-read.service';
import { WorkflowAccessService } from './workflow-access.service';

/** How long an invocation waits before handing back a run handle to poll. */
export const DEFAULT_INVOKE_AWAIT_MS = 15_000;
/** Ceiling on that wait — past it the caller polls rather than holding a connection open. */
export const MAX_INVOKE_AWAIT_MS = 60_000;

/** What an invocation answers with: the workflow's own reply, or a handle to poll for it. */
export interface InvokeResult {
  run_id: string;
  status: 'completed' | 'running';
  /** The terminal-node output ({@link extractChatReply}) — absent while the run is still going. */
  output?: unknown;
  /** Where to read the run once it outlives the bounded wait. */
  poll_with?: string;
}

/** The published target an invocation fires: the pinned version plus the env its steps resolve in. */
interface ProductionTarget {
  versionId: string;
  environment: string;
  environmentId: string | null;
}

/**
 * Workflow-as-tool invocation: fire the workflow's PRODUCTION version with the caller's
 * arguments as the firing event and answer with what it replied.
 *
 * The locked design: only what is published is callable, resolved through {@link EnvPointersService}
 * (never a branch head, so an unpublished draft is uncallable); only a workflow whose trigger is
 * `orchestr:tool_trigger` is invocable; the arguments ARE the trigger event, so `{{trigger.<name>}}`
 * resolves exactly as a webhook payload does; the answer is {@link extractChatReply}, the ONE rule
 * the chat intake and the sub-workflow runner already share; and it fires for real — no dry-run
 * mode, because invocation exists to do the thing.
 */
@Injectable()
export class WorkflowInvokeService {
  private readonly logger = new Logger(WorkflowInvokeService.name);

  constructor(
    private readonly reads: WorkflowsReadService,
    private readonly envPointers: EnvPointersService,
    private readonly environments: EnvironmentsService,
    private readonly access: WorkflowAccessService,
    private readonly runs: RunsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async invoke(
    principal: Principal,
    workflowId: string,
    args: Record<string, unknown>,
    awaitMs: number,
  ): Promise<InvokeResult> {
    const em = this.dataSource.manager;
    const wf = await this.reachableWorkflow(principal, workflowId);
    const target = await this.productionTarget(em, wf);
    const ir = await this.invocableIr(em, wf, target);

    // Audit trail for the surface where an agent fires a real side effect.
    this.logger.log(
      `invoke → "${wf.name}" (${wf.id}) v=${target.versionId} env=${target.environment} ` +
        `as user=${principal.user.id} kind=${principal.kind}`,
    );
    const outcome = await this.runs.runFromIrBounded(ir, {
      externalUserId: principal.user.id,
      activeOrgId: principal.activeOrgId,
      workflowId: wf.id,
      workflowVersionId: target.versionId,
      source: 'mcp',
      initialScope: { trigger: args },
      ...(target.environmentId
        ? { environment: target.environment, environmentId: target.environmentId, orgId: wf.orgId }
        : {}),
      awaitMs,
    });
    return this.answer(ir, outcome);
  }

  /**
   * Load the target through the SAME policy point every workflow route uses. A workflow the caller
   * may not reach must be indistinguishable from a missing one — hence the identical 404, never a 403.
   */
  private async reachableWorkflow(principal: Principal, workflowId: string): Promise<WorkflowEntity> {
    return this.access.require(principal, workflowId, 'read');
  }

  /**
   * The version production runs, through the ONE pointer seam. No pointer is a clean refusal and
   * never a fall back to a branch head: committing must not change what an agent can call.
   */
  private async productionTarget(em: EntityManager, wf: WorkflowEntity): Promise<ProductionTarget> {
    const env = wf.orgId ? await this.environments.findByNameForOrg(em, wf.orgId, PROD_ENV) : null;
    const versionId = env
      ? await this.envPointers.resolveVersionIdForEnv(em, wf, env)
      : await this.envPointers.resolveVersionId(em, wf, PROD_ENV);
    if (!versionId) {
      throw new DomainError(
        `Workflow "${wf.name}" has no version published to production, so it can't be invoked — ` +
          'publish it first. Saving or committing a change does not publish it.',
        409,
        { code: 'not_published' },
      );
    }
    return { versionId, environment: env?.name ?? PROD_ENV, environmentId: env?.id ?? null };
  }

  /** The published document, refused unless it declares itself agent-callable. */
  private async invocableIr(
    em: EntityManager,
    wf: WorkflowEntity,
    target: ProductionTarget,
  ): Promise<WorkflowIR> {
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: target.versionId } });
    const ir = version?.workflowIr as unknown as WorkflowIR | undefined;
    if (!ir) {
      throw new DomainError(`Workflow "${wf.name}" has no runnable published document.`, 409, {
        code: 'no_document',
      });
    }
    // The full contract, not just the trigger's presence: an undescribed tool is withheld from the
    // tool LIST, so accepting it here would publish a call nobody could discover.
    if (!contractOfDocument(ir, wf.name)) {
      throw new DomainError(
        `Workflow "${wf.name}" isn't callable as a tool — the version live in production has no ` +
          `"Called by another workflow" trigger (${AGENT_TOOL_PUBLIC}) declaring a name and description. ` +
          'Add that trigger, describe it, then publish.',
        400,
        { code: 'not_invocable' },
      );
    }
    return ir;
  }

  /** The workflow's ANSWER, never its whole output scope — one rule, shared with chat and sub-workflows. */
  private answer(ir: WorkflowIR, outcome: RunOutcome): InvokeResult {
    if ('status' in outcome) {
      return { run_id: outcome.run_id, status: 'running', poll_with: `/api/runs/${outcome.run_id}` };
    }
    return {
      run_id: outcome.run_id ?? '',
      status: 'completed',
      output: extractChatReply(ir, outcome),
    };
  }
}
