import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Allow, IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { isIdShape } from '../database/ids';
import type { RunSource } from '../database/entities/runtime-run.entity';
import type { WorkflowIR } from '../ir/models';
import { channelKey } from '../runtime/agent-step-bus';
import type { RunHandle, RunOutcome, RunPlan, RunResult } from '../runtime/run-plan';
import { runAccessOf, type RunAccess } from './run-access';
import { RunsService, type IrRunOptions } from './runs.service';
import { Scope } from '../auth/scope.decorator';
import { DomainError } from '../common/domain-error';

class CreateRunDto {
  /** The RunPlan to execute (validated structurally at runtime by the interpreter). */
  @IsObject()
  plan!: RunPlan;

  /** Optional idempotency/resume key, scoped to the caller; a UUID is generated when omitted. */
  @IsOptional()
  @IsString()
  run_id?: string;

  /** Dry run (preview): fire no state-changing external call. */
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}

/** Longest a caller may hold a request open on a run before it must take a handle and poll. */
const MAX_AWAIT_MS = 60_000;

/** The run-provenance fields the document-bearing entry points share. */
interface RunProvenance {
  run_id?: string;
  workflow_id?: string;
  trigger_payload?: Record<string, unknown>;
}

/** `POST /runs/async`: start durably without waiting — a raw RunPlan or a WorkflowIR, exactly one. */
class StartAsyncDto {
  @IsOptional()
  @IsObject()
  plan?: RunPlan;

  /** A WorkflowIR, compiled through the same seam `from-ir` uses. */
  @IsOptional()
  @IsObject()
  workflow_ir?: WorkflowIR;

  @IsOptional()
  @IsString()
  run_id?: string;

  /** Link this run to a workflow (runs panel history). Must exist in the caller's active org — 404 otherwise. */
  @IsOptional()
  @IsString()
  workflow_id?: string;

  /** The trigger event to run with — arrives in scope as `trigger` (trigger nodes compile away). */
  @IsOptional()
  @IsObject()
  trigger_payload?: Record<string, unknown>;

  /** Declared only so it can be REFUSED: a dry run is never durable. */
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}

class SendEventDto {
  @IsString()
  topic!: string;

  /** Arbitrary event payload (e.g. an approval decision). */
  @Allow()
  payload?: unknown;
}

class RunFromIrDto {
  /** A WorkflowIR (from generation) — compiled to a RunPlan and run. */
  @IsObject()
  workflow_ir!: WorkflowIR;

  @IsOptional()
  @IsString()
  run_id?: string;

  /** Link this run to a workflow (runs panel history). Must exist in the caller's active org — 404 otherwise. */
  @IsOptional()
  @IsString()
  workflow_id?: string;

  /** The trigger event to run with — arrives in scope as `trigger` (trigger nodes compile away). */
  @IsOptional()
  @IsObject()
  trigger_payload?: Record<string, unknown>;

  /** TRUE PINNING: ephemeral `{ [nodeId]: output }` overrides — a pinned node replays instead of calling the provider. */
  @IsOptional()
  @IsObject()
  pins?: Record<string, unknown>;

  /** Dry run (preview): fire NO state-changing external call; recorded as a dry run. */
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;

  /** Bounded wait in ms: the full result when the run settles in time, else `{run_id, status:'running'}` to poll. Absent = wait for the run. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_AWAIT_MS)
  await_ms?: number;
}
// SECURITY: `environment` is deliberately NOT caller-supplied — it would let a member run a
// hand-crafted IR on the org's prod connections. Env is threaded only from deployed-trigger dispatch.

/** One IR node to test in isolation, plus the observed upstream samples to seed. */
class TestStepDto {
  /** `{ id, node_type, name?, parameters? }` — the single step to run. */
  @IsObject()
  node!: { id: string; node_type: string; name?: string; parameters?: Record<string, unknown> };

  /** node id (or `trigger`) → previously observed output, seeded so `{{stepId.field}}` refs resolve. */
  @IsOptional()
  @IsObject()
  sample_scope?: Record<string, unknown>;
}

/** "Test this agent": run ONE agent node out of the full draft document (its tools are canvas edges). */
class TestAgentDto {
  /** The FULL draft document — the agent's tools are `port_type:'tool'` edges in it. */
  @IsObject()
  workflow_ir!: Record<string, unknown>;

  /** The agent node to run. */
  @IsString()
  node_id!: string;

  /** The task/user message for THIS test — overrides the node's input expression as a literal. */
  @IsOptional()
  @IsString()
  input?: string;

  /** node id (or `trigger`) → previously observed output, seeded so `{{…}}` refs in tool params resolve. */
  @IsOptional()
  @IsObject()
  sample_scope?: Record<string, unknown>;

  /** With `session_id`, the streaming rendezvous: the client must subscribe to the SSE channel BEFORE posting this. */
  @IsOptional()
  @IsString()
  workflow_id?: string;

  @IsOptional()
  @IsString()
  session_id?: string;
}

/** Pseudo-env a "Test this agent" stream rendezvouses under — must stay in lockstep with the client's `testAgentStep` helper. */
const AGENT_TEST_ENV = 'draft';

/** Exactly one of `plan` / `workflow_ir` — a body carrying both, or neither, is a caller bug rather than a guess. */
function asyncRunSource(body: StartAsyncDto): { plan: RunPlan } | { ir: WorkflowIR } {
  if (body.plan && body.workflow_ir) {
    throw new DomainError('Send either `plan` or `workflow_ir`, not both.', 400);
  }
  if (body.workflow_ir) return { ir: body.workflow_ir };
  if (body.plan) return { plan: body.plan };
  throw new DomainError('An asynchronous run needs a `plan` or a `workflow_ir`.', 400);
}

/** The engine's HTTP surface: sync runs, the async durable trio, and the `waiting` approvals inbox. */
@Controller('api/runs')
@UseGuards(AuthGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  private userId(req: Request): string {
    return requirePrincipal(req).user.id;
  }

  private access(req: Request): RunAccess {
    return runAccessOf(requirePrincipal(req));
  }

  /**
   * The run id a caller may set. A non-interactive principal may NOT: `runtime_runs` inserts
   * `ON CONFLICT DO NOTHING`, so replaying a prior id would execute with no new history row —
   * an agent could erase its own audit trail. Use `Idempotency-Key` for retry safety instead.
   */
  private requestedRunId(req: Request, runId: string | undefined): string | undefined {
    if (runId === undefined) return undefined;
    if (requirePrincipal(req).kind !== 'api_key') return runId;
    throw new DomainError(
      'run_id is chosen by the server for API-key callers — read it off the response, and use an Idempotency-Key header if you need retry safety.',
      400,
      { code: 'run_id_not_accepted' },
    );
  }

  /** The provenance a document-bearing entry point threads onto its run. */
  private runOptions(req: Request, body: RunProvenance, source: RunSource): IrRunOptions {
    const principal = requirePrincipal(req);
    return {
      externalUserId: principal.user.id,
      runId: this.requestedRunId(req, body.run_id),
      workflowId: body.workflow_id ?? null,
      activeOrgId: principal.activeOrgId,
      source,
      initialScope: body.trigger_payload ? { trigger: body.trigger_payload } : undefined,
    };
  }

  /** Run a plan synchronously and return the result (best for short plans). */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('run:execute')
  @Post()
  run(@Req() req: Request, @Body() body: CreateRunDto): Promise<RunResult> {
    return this.runs.run(body.plan, {
      externalUserId: this.userId(req),
      runId: this.requestedRunId(req, body.run_id),
      source: 'api',
      dryRun: body.dry_run,
    });
  }

  /**
   * Compile a WorkflowIR (generation output) to a plan and run it. With `await_ms` the wait is
   * BOUNDED: a run that outlives it answers `{run_id, status:'running'}` and is polled via `GET :runId`.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('run:execute')
  @Post('from-ir')
  runFromIr(@Req() req: Request, @Body() body: RunFromIrDto): Promise<RunOutcome> {
    const opts: IrRunOptions = {
      ...this.runOptions(req, body, 'manual'),
      pins: body.pins,
      dryRun: body.dry_run,
    };
    return body.await_ms === undefined
      ? this.runs.runFromIr(body.workflow_ir, opts)
      : this.runs.runFromIrBounded(body.workflow_ir, { ...opts, awaitMs: body.await_ms });
  }

  /** Test ONE step in isolation — transient, not recorded in run history. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('run:execute')
  @Post('test-step')
  testStep(@Req() req: Request, @Body() body: TestStepDto): Promise<RunResult> {
    return this.runs.testStep(body.node, body.sample_scope ?? {}, {
      externalUserId: this.userId(req),
    });
  }

  /** Test ONE agent node with its real tools — transient, streams live steps. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('run:execute')
  @Post('test-agent')
  testAgent(@Req() req: Request, @Body() body: TestAgentDto): Promise<RunResult> {
    const chatChannelKey =
      body.workflow_id && body.session_id
        ? channelKey(body.workflow_id, AGENT_TEST_ENV, body.session_id)
        : null;
    return this.runs.testAgent(body.workflow_ir as unknown as WorkflowIR, body.node_id, {
      externalUserId: this.userId(req),
      input: body.input,
      sampleScope: body.sample_scope ?? {},
      chatChannelKey,
    });
  }

  /** Start a plan or a WorkflowIR asynchronously (long-running / human-in-the-loop). Requires DBOS. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('run:execute')
  @Post('async')
  async startAsync(@Req() req: Request, @Body() body: StartAsyncDto): Promise<RunHandle> {
    if (body.dry_run) {
      throw new DomainError(
        'A dry run is never durable — preview with POST /api/runs/from-ir and `dry_run`.',
        400,
      );
    }
    const source = asyncRunSource(body);
    const { runId } = await this.runs.startRun(
      source,
      this.runOptions(req, body, 'ir' in source ? 'manual' : 'api'),
    );
    return { run_id: runId, status: 'running' };
  }

  /** The caller's run history, newest first; `?workflow_id=` filters. */
  @Scope('workflow:read')
  @Get()
  async listRuns(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('workflow_id') workflowId?: string,
  ): Promise<Record<string, unknown>> {
    const parsed = limit !== undefined && limit !== '' ? Number(limit) : 50;
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new HttpException({ detail: 'limit must be a positive integer' }, 400);
    }
    return {
      runs: await this.runs.listRuns(this.userId(req), {
        limit: parsed,
        workflowId: this.parsedWorkflowId(workflowId),
      }),
    };
  }

  /** Sample data for the editor's picker: the caller's latest completed run. Must stay declared before `:runId` so the literal path wins. */
  @Scope('workflow:read')
  @Get('samples')
  async samples(
    @Req() req: Request,
    @Query('workflow_id') workflowId?: string,
  ): Promise<Record<string, unknown>> {
    const parsed = this.parsedWorkflowId(workflowId);
    if (!parsed) throw new HttpException({ detail: 'workflow_id is required' }, 400);
    return { sample: await this.runs.latestRunOutputs(this.userId(req), parsed) };
  }

  /** The approvals inbox: runs parked on a `waitForEvent` node. Must stay declared before `:runId` so the literal path wins. */
  @Scope('workflow:read')
  @Get('waiting')
  async listWaiting(
    @Req() req: Request,
    @Query('workflow_id') workflowId?: string,
  ): Promise<Record<string, unknown>> {
    return {
      runs: await this.runs.listWaitingRuns(this.access(req), this.parsedWorkflowId(workflowId)),
    };
  }

  /** A run's status + step log (works for durable AND direct runs). */
  @Scope('workflow:read')
  @Get(':runId')
  async getRun(@Req() req: Request, @Param('runId') runId: string): Promise<Record<string, unknown>> {
    const s = await this.runs.getRun(runId, this.access(req));
    return {
      run_id: s.runId,
      workflow_id: s.workflow_id,
      workflow_name: s.workflow_name,
      // Which env + exact version this run executed; the env name is a historical
      // snapshot ("Default" when null), the id links the live row (null once deleted).
      workflow_version_id: s.workflow_version_id,
      environment: s.environment,
      environment_id: s.environment_id,
      status: s.status,
      source: s.source,
      dry_run: s.dry_run,
      outputs: s.outputs,
      error: s.error,
      steps: s.steps ?? [],
      started_at: s.started_at ?? null,
      finished_at: s.finished_at ?? null,
      duration_ms: s.duration_ms,
      decided_by: s.decided_by,
      decided_at: s.decided_at,
      // Both ends of a sub-workflow call — a nested run is recorded under the workflow
      // that ran it, so these are the only path between the two.
      called_by: s.called_by,
      calls: s.calls,
    };
  }

  /** Resume a run parked on a `waitForEvent` node (deliver an approval decision). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Scope('run:execute')
  @Post(':runId/events')
  async sendEvent(
    @Req() req: Request,
    @Param('runId') runId: string,
    @Body() body: SendEventDto,
  ): Promise<{ status: string }> {
    await this.runs.sendEvent(runId, body.topic, body.payload, this.access(req));
    return { status: 'sent' };
  }

  /** Cancel a run — DBOS interrupts durable runs, direct runs are best-effort. Idempotent when already terminal. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Scope('run:execute')
  @Post(':runId/cancel')
  async cancel(@Req() req: Request, @Param('runId') runId: string): Promise<{ status: string }> {
    const result = await this.runs.cancelRun(runId, this.access(req));
    return { status: result.status };
  }

  /** `?workflow_id=` must be a uuid when present — garbage is a caller bug, not an empty list. */
  private parsedWorkflowId(workflowId?: string): string | undefined {
    if (workflowId === undefined || workflowId === '') return undefined;
    if (!isIdShape(workflowId)) {
      throw new HttpException({ detail: 'workflow_id must be a UUID' }, 400);
    }
    return workflowId;
  }
}
