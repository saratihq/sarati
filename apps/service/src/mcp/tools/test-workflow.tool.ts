import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { principalScopes } from '../../auth/principal';
import type { ApiScope } from '../../auth/scopes';
import { scopeSatisfied } from '../../auth/scopes';
import { DomainError } from '../../common/domain-error';
import { RunsService } from '../../runs/runs.service';
import type { RunHandle, RunOutcome, RunResult } from '../../runtime/run-plan';
import { WorkflowsReadService } from '../../workflows/workflows-read.service';
import { LiveRunConsentService } from '../live-run-consent.service';
import type { McpCallContext, McpTool } from '../mcp-tool';

/** Long enough for a real workflow to finish, short enough that the agent is not left hanging. */
const DEFAULT_AWAIT_MS = 15_000;

const Input = z.object({
  workflow_ir: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The document to run. Give this OR workflow_id, not both.'),
  workflow_id: z.string().optional().describe('Run the head of this workflow instead of a document.'),
  branch: z.string().optional().describe('Which branch head to run; defaults to the default branch.'),
  trigger_payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Stands in for the event that would normally start the workflow.'),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      'Defaults to TRUE. A dry run stubs mutating HTTP on the SDK rail and skips Composio execution entirely — but GET and HEAD still hit real third-party systems with real credentials.',
    ),
  confirmation_token: z
    .string()
    .optional()
    .describe('Required only when dry_run is false: the token returned by a dry run of this exact document.'),
  await_ms: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe('How long to wait before handing back a run handle to poll. Defaults to 15000.'),
});

const Step = z.object({
  node_id: z.string(),
  /** Honesty notes from the rail — the step still succeeded. */
  warnings: z.array(z.string()),
});

const Output = z.object({
  run_id: z.string(),
  status: z.string().describe('`running` means it outlived the wait — poll with orchestr_get_run.'),
  dry_run: z.boolean(),
  credentials_used: z
    .literal('personal_pool')
    .describe(
      "A test resolves connections from the caller's own pool, never an environment's slots, so a passing test does not prove the workflow will run in production.",
    ),
  steps: z
    .array(Step)
    .describe('The steps that ran. A FAILED run comes back as an error carrying its failing node.'),
  output_summary: z.record(z.string(), z.unknown()).nullable(),
  /** Present only after a dry run: quote it to fire the same document for real. */
  confirmation_token: z.string().optional(),
  poll_with: z.string().optional(),
});

/** A run that outlived the wait carries only a handle; everything else is a finished result. */
function isHandle(outcome: RunOutcome): outcome is RunHandle {
  return 'status' in outcome;
}

function stepsOf(result: RunResult): z.infer<typeof Step>[] {
  return result.trace.map((entry) => ({ node_id: entry.nodeId, warnings: entry.warnings ?? [] }));
}

/**
 * The only tool that can touch the outside world. Dry by default; firing for real needs the
 * `run:execute` scope AND fresh consent for this exact document, both enforced in services rather
 * than in this schema — the same token is a bearer on `POST /api/runs/from-ir`.
 */
@Injectable()
export class TestWorkflowTool implements McpTool {
  readonly name = 'orchestr_test_workflow';
  readonly scope: ApiScope = 'run:dry';
  readonly title = 'Test a workflow';
  readonly description =
    'Run a workflow to see what it does. Dry by default: mutating HTTP on the SDK rail is stubbed and Composio execution is skipped entirely — but GET and HEAD still hit real third-party systems with real credentials. It resolves connections from your own pool, not an environment, so a passing test does not prove the workflow will run in production. Firing for real needs dry_run: false plus the confirmation_token from a dry run of the same document.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };

  constructor(
    private readonly runs: RunsService,
    private readonly reads: WorkflowsReadService,
    private readonly consent: LiveRunConsentService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    const dryRun = args.dry_run !== false;
    const ir = await this.documentFor(args);

    if (!dryRun) this.authorizeLiveRun(ctx, args.confirmation_token, ir);

    const outcome = await this.runs.runFromIrBounded(ir as never, {
      externalUserId: ctx.principal.user.id,
      activeOrgId: ctx.principal.activeOrgId,
      workflowId: args.workflow_id ?? null,
      source: 'manual',
      initialScope: args.trigger_payload ? { trigger: args.trigger_payload } : undefined,
      dryRun,
      awaitMs: args.await_ms ?? DEFAULT_AWAIT_MS,
    });

    return this.report(outcome, dryRun, ctx, ir);
  }

  /** A live run needs the scope AND consent AND budget — refused in that order, so the reason is the first one that applies. */
  private authorizeLiveRun(ctx: McpCallContext, token: string | undefined, ir: unknown): void {
    const scopes = principalScopes(ctx.principal);
    if (!scopeSatisfied(scopes, 'run:execute')) {
      throw new DomainError(
        'This credential may preview a workflow but not fire it — firing for real needs the "run:execute" scope.',
        403,
        { code: 'live_run_not_permitted' },
      );
    }
    this.consent.consume(ctx.principal.user.id, token, ir);
    this.consent.chargeLiveRun(ctx.principal.user.id);
  }

  /** The document to run: the one given, or the head of the named workflow/branch. */
  private async documentFor(args: z.infer<typeof Input>): Promise<Record<string, unknown>> {
    if (args.workflow_ir && args.workflow_id) {
      throw new DomainError(
        'Give either workflow_ir or workflow_id, not both — otherwise which document runs is ambiguous.',
        400,
        { code: 'ambiguous_document' },
      );
    }
    if (args.workflow_ir) return args.workflow_ir;
    if (!args.workflow_id) {
      throw new DomainError('Give a workflow_ir to run, or a workflow_id to run its head.', 400, {
        code: 'no_document',
      });
    }
    const head = await this.reads.getBranchHead(args.workflow_id, args.branch ?? null);
    if (!head.head) {
      throw new DomainError(`Branch "${head.branch.name}" has no committed version to run yet.`, 404, {
        code: 'branch_empty',
      });
    }
    return { nodes: head.head.nodes, edges: head.head.edges, settings: {}, metadata: {} };
  }

  private report(
    outcome: RunOutcome,
    dryRun: boolean,
    ctx: McpCallContext,
    ir: unknown,
  ): z.infer<typeof Output> {
    const running = isHandle(outcome);
    const steps = running ? [] : stepsOf(outcome);
    return {
      run_id: outcome.run_id ?? '',
      status: running ? 'running' : 'completed',
      dry_run: dryRun,
      credentials_used: 'personal_pool',
      steps,
      output_summary: running ? null : outcome.outputs,
      // A fresh dry run is what licenses the next live one, so the token rides its result.
      ...(dryRun ? { confirmation_token: this.consent.issue(ctx.principal.user.id, ir) } : {}),
      ...(running ? { poll_with: 'orchestr_get_run' } : {}),
    };
  }
}
