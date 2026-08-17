import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { LiveRunConsentService } from './live-run-consent.service';
import { toToolError, toToolResult } from './presentation/result';
import { WorkflowInvokeService } from '../workflows/workflow-invoke.service';
import type { WorkflowTool, WorkflowToolInput } from '../workflows/callable-workflows.service';

/** Long enough for a real automation to answer, short enough that the agent is not left hanging. */
const DEFAULT_AWAIT_MS = 15_000;

/** What a caller gets back: the workflow's answer, or a handle when it outlives the wait. */
const Output = z.object({
  run_id: z.string(),
  status: z.string(),
  result: z.unknown().nullable().describe("The workflow's answer — its Respond node, or its last step."),
  poll_with: z.string().optional(),
});

function fieldOf(input: WorkflowToolInput): z.ZodTypeAny {
  const base =
    input.type === 'number'
      ? z.number()
      : input.type === 'boolean'
        ? z.boolean()
        : input.type === 'object'
          ? z.record(z.string(), z.unknown())
          : z.string();
  const described = input.description ? base.describe(input.description) : base;
  return input.required ? described : described.optional();
}

/** The declared inputs as a schema an MCP client validates against before it will call. */
export function inputSchemaOf(tool: WorkflowTool): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return z.object(Object.fromEntries(tool.inputs.map((input) => [input.name, fieldOf(input)])));
}

/**
 * Registers a tenant's published workflows as callable tools (ADR 0053). Unlike every other tool,
 * these fire real side effects by design — invocation exists to do the thing — so they are gated by
 * the `workflow:invoke` scope and charged against the same hourly budget as a live test run.
 */
@Injectable()
export class WorkflowInvokeTool {
  private readonly logger = new Logger(WorkflowInvokeTool.name);

  constructor(
    private readonly consent: LiveRunConsentService,
    private readonly invoker: WorkflowInvokeService,
  ) {}

  register(server: McpServer, tool: WorkflowTool, principal: Principal): void {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: `${tool.description}\n\nRuns your live "${tool.name}" automation for real.`,
        inputSchema: inputSchemaOf(tool),
        outputSchema: Output,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          this.consent.chargeLiveRun(principal.user.id);
          const outcome = await this.invoker.invoke(
            principal,
            tool.workflowId,
            (args ?? {}) as Record<string, unknown>,
            DEFAULT_AWAIT_MS,
          );
          this.logger.log(
            `invoked "${tool.name}" (${tool.workflowId}) as user=${principal.user.id} run=${outcome.run_id}`,
          );
          return toToolResult({
            run_id: outcome.run_id,
            status: outcome.status,
            result: outcome.output ?? null,
            // The REST path returns a URL; over MCP the caller polls with the tool it already has.
            ...(outcome.status === 'running' ? { poll_with: 'orchestr_get_run' } : {}),
          });
        } catch (err) {
          const message = errorMessage(err);
          const code = err instanceof DomainError ? err.details?.code : undefined;
          this.logger.warn(`invoking "${tool.name}" failed: ${message}`);
          return toToolError(message, typeof code === 'string' ? code : undefined);
        }
      },
    );
  }
}
