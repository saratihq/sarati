import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { DomainError } from '../../common/domain-error';
import { runAccessOf } from '../../runs/run-access';
import { RunsService } from '../../runs/runs.service';
import { failedNodeIdOf } from '../../runs/run-failure';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({
  run_id: z
    .string()
    .min(1)
    .describe('The run handle a run listing or an execution returned (`<owner>:<run>` or a bare run id).'),
  include_step_outputs: z
    .boolean()
    .default(false)
    .describe(
      'Include each step’s full provider payload. Off by default — payloads are unbounded third-party content; read the log first and ask for outputs only when you need them.',
    ),
});

const Step = z.object({
  node_id: z.string(),
  kind: z.string(),
  status: z.string(),
  /** Provider calls this step took — greater than 1 means it was retried. */
  attempts: z.number(),
  /** The step errored but the run continued past it (continue-on-fail). */
  continued: z.boolean(),
  /** The step replayed a pinned sample instead of calling the provider. */
  pinned: z.boolean(),
  error: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  output: z.unknown().optional(),
});

const Output = z.object({
  run_id: z.string(),
  status: z.string(),
  workflow_id: z.string().nullable(),
  workflow_name: z.string().nullable(),
  workflow_version_id: z.string().nullable(),
  environment: z.string().nullable(),
  source: z.string().nullable(),
  /** The run fired no state-changing external call. */
  dry_run: z.boolean(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  error: z.string().nullable(),
  /** The node whose failure ended the run; null when it completed or every failure was tolerated. */
  failed_node_id: z.string().nullable(),
  /** Non-fatal notes from the rails and from `{{ref}}`s that resolved to nothing. */
  warnings: z.array(z.object({ node_id: z.string(), message: z.string() })),
  steps: z.array(Step),
  outputs: z.record(z.string(), z.unknown()).optional(),
  /** Whether payloads are present at all — so an empty log is never mistaken for an empty run. */
  step_outputs_included: z.boolean(),
});

type StepRow = Record<string, unknown>;

function str(row: StepRow, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function nullableStr(row: StepRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function warningsOf(steps: readonly StepRow[]): Array<{ node_id: string; message: string }> {
  return steps.flatMap((s) => {
    const list = Array.isArray(s.warnings) ? s.warnings : [];
    return list
      .filter((w): w is string => typeof w === 'string')
      .map((message) => ({ node_id: str(s, 'node_id'), message }));
  });
}

function toStep(row: StepRow, includeOutputs: boolean): z.infer<typeof Step> {
  return {
    node_id: str(row, 'node_id'),
    kind: str(row, 'kind'),
    status: str(row, 'status'),
    attempts: typeof row.attempts === 'number' ? row.attempts : 1,
    continued: row.continued === true,
    pinned: row.pinned === true,
    error: nullableStr(row, 'error'),
    started_at: nullableStr(row, 'started_at'),
    finished_at: nullableStr(row, 'finished_at'),
    ...(includeOutputs ? { output: row.output ?? null } : {}),
  };
}

@Injectable()
export class GetRunTool implements McpTool {
  readonly name = 'orchestr_get_run';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Get a run';
  readonly description =
    'Run status, per-step log, the failing node and any warnings. A run is readable only by the credential that owns it — org-wide reach belongs to a human session, not to a key.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(private readonly runs: RunsService) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { run_id, include_step_outputs } = Input.parse(input);
    // The flag is a READ option, not a filter over an already-assembled payload.
    const detail = await this.runs.getRun(run_id, runAccessOf(ctx.principal), {
      includeStepOutputs: include_step_outputs,
    });
    if (detail.status === 'not_found') {
      throw new DomainError(
        `Run ${run_id} not found — it does not exist, or it is not readable by this credential.`,
        404,
      );
    }
    const steps: StepRow[] = detail.steps ?? [];

    return {
      run_id: detail.runId,
      status: detail.status,
      workflow_id: detail.workflow_id,
      workflow_name: detail.workflow_name,
      workflow_version_id: detail.workflow_version_id,
      environment: detail.environment,
      source: detail.source,
      dry_run: detail.dry_run,
      started_at: detail.started_at ?? null,
      finished_at: detail.finished_at ?? null,
      duration_ms: detail.duration_ms,
      error: detail.error ?? null,
      failed_node_id: failedNodeIdOf(steps),
      warnings: warningsOf(steps),
      steps: steps.map((s) => toStep(s, include_step_outputs)),
      ...(include_step_outputs ? { outputs: detail.outputs ?? {} } : {}),
      step_outputs_included: include_step_outputs,
    };
  }
}
