import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { PROD_ENV } from '../../environments/env-name';
import { WorkflowsReadService, type WorkflowSummary } from '../../workflows/workflows-read.service';
import type { McpCallContext, McpTool } from '../mcp-tool';
import { decodeOffsetCursor, encodeOffsetCursor } from '../offsetCursor';

const Input = z.object({
  query: z.string().max(200).optional().describe('Case-insensitive substring of the workflow name.'),
  limit: z.number().int().min(1).max(50).default(8),
  cursor: z.string().optional().describe('`next_cursor` from a previous call, continuing the same query.'),
});

const Output = z.object({
  workflows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      updated_at: z.string().nullable(),
      is_live: z.boolean().describe('Whether a version is running in at least one environment.'),
      live_environments: z.array(z.string()),
    }),
  ),
  total: z.number(),
  next_cursor: z.string().nullable(),
});

/** `active` is the production pointer; the rest are the workflow's other live environments. */
function summarize(wf: WorkflowSummary): z.infer<typeof Output>['workflows'][number] {
  const liveEnvironments = [...(wf.active ? [PROD_ENV] : []), ...wf.environments];
  return {
    id: wf.id,
    name: wf.name,
    updated_at: wf.updated_at,
    is_live: liveEnvironments.length > 0,
    live_environments: liveEnvironments,
  };
}

@Injectable()
export class ListWorkflowsTool implements McpTool {
  readonly name = 'orchestr_list_workflows';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'List workflows';
  readonly description =
    'The workflows in this organization, most recently created first. Says which environments each one is live in; call orchestr_get_workflow for the graph of one.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(private readonly reads: WorkflowsReadService) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { query, limit, cursor } = Input.parse(input);
    const offset = decodeOffsetCursor(cursor);
    const page = await this.reads.listWorkflows(
      ctx.principal.user.id,
      ctx.principal.activeOrgId,
      limit,
      offset,
      query ?? null,
    );

    return {
      workflows: page.workflows.map(summarize),
      total: page.total,
      next_cursor: page.has_more ? encodeOffsetCursor(offset + page.workflows.length) : null,
    };
  }
}
