import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { DiffService } from '../../workflows/diff.service';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({
  workflow_id: z.uuid().describe('The workflow both versions belong to.'),
  from_version_id: z
    .uuid()
    .describe('Base version id. Version NUMBERS are per-branch and are never accepted here.'),
  to_version_id: z
    .uuid()
    .describe('Head version id. Version NUMBERS are per-branch and are never accepted here.'),
});

const Side = z.object({
  version_id: z.string(),
  version_number: z.number(),
  branch: z.string().nullable(),
  commit_message: z.string().nullable(),
});

const Output = z.object({
  workflow_id: z.string(),
  from: Side,
  to: Side,
  summary: z.string(),
  /** Field-level ops keyed by `(node_id, path)`; `path` is null for a whole-node add/remove. */
  node_changes: z.array(
    z.object({
      operation: z.string(),
      node_id: z.string(),
      node_name: z.string().nullable(),
      path: z.string().nullable(),
      old_value: z.unknown(),
      new_value: z.unknown(),
    }),
  ),
  /** Connection ops keyed by the endpoint tuple incl. `port_type` — never by the edge id. */
  edge_changes: z.array(
    z.object({
      operation: z.string(),
      source_node_id: z.string(),
      source_port: z.number(),
      target_node_id: z.string(),
      target_port: z.number(),
      port_type: z.string(),
    }),
  ),
  settings_changes: z.array(
    z.object({ path: z.string().nullable(), old_value: z.unknown(), new_value: z.unknown() }),
  ),
  renames: z.array(z.object({ old_name: z.string(), new_name: z.string() })),
  /** Rename collapse is a display heuristic: it never feeds apply/merge, so never replay it as an edit. */
  renames_are_presentational: z.literal(true),
});

@Injectable()
export class DiffTool implements McpTool {
  readonly name = 'orchestr_diff';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Diff two versions';
  readonly description =
    'The field-level change set between two versions, keyed by node and path — never a text diff. Both sides are version ids: a version NUMBER means nothing without its branch, because numbers are per-branch. Connection changes are keyed by the endpoint tuple including port_type, so a main and an error edge between the same nodes are distinct.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(private readonly diffs: DiffService) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    const changes = await this.diffs.getChangeSet(
      ctx.principal,
      args.workflow_id,
      { id: args.from_version_id },
      { id: args.to_version_id },
    );
    return { ...changes, renames_are_presentational: true };
  }
}
