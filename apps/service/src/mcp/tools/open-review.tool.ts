import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { ReviewProposalService } from '../../reviews/review-proposal.service';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({
  workflow_id: z.uuid().describe('The workflow both branches belong to.'),
  source_branch: z.string().min(1).max(200).describe('The branch carrying the proposed change.'),
  target_branch: z.string().min(1).max(200).describe('The branch it would land on, e.g. main.'),
  title: z.string().min(1).max(255).describe('What a human sees in the review list.'),
  description: z
    .string()
    .max(10_000)
    .optional()
    .describe('Why the change was made — the reviewer reads this before the diff.'),
});

const DiffSummary = z.object({
  from_version_id: z.string().describe("The target branch's head — the base being reviewed."),
  to_version_id: z.string().describe("The source branch's head — what is being proposed."),
  summary: z.string(),
  /** Field-level ops keyed by `(node_id, path)`; `path` is null for a whole-node add/remove. */
  node_changes: z.array(
    z.object({
      operation: z.string(),
      node_id: z.string(),
      node_name: z.string().nullable(),
      path: z.string().nullable(),
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
  settings_changes: z.array(z.object({ path: z.string().nullable() })),
  renames: z.array(z.object({ old_name: z.string(), new_name: z.string() })),
  /** Rename collapse is a display heuristic: it never feeds apply/merge, so never replay it as an edit. */
  renames_are_presentational: z.literal(true),
});

const Output = z.object({
  review_id: z.string(),
  review_url: z.string().describe('The page a human opens to read, comment on and merge this review.'),
  title: z.string(),
  status: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  diff_summary: DiffSummary.nullable().describe(
    'What the reviewer is being asked to approve, without the values — call orchestr_diff with from_version_id/to_version_id for those. Null only when a branch has no commit to compare.',
  ),
  mergeable: z
    .union([z.boolean(), z.literal('unknown')])
    .describe(
      'A read-only three-way merge probe that minted no version and moved no branch. False means field-level conflicts a human must resolve; "unknown" means it could not be evaluated.',
    ),
});

@Injectable()
export class OpenReviewTool implements McpTool {
  readonly name = 'orchestr_open_review';
  readonly scope: ApiScope = 'workflow:write';
  readonly title = 'Open a review';
  readonly description =
    "Propose a branch's changes to a human, with the field-level diff they will review. This is an agent's terminal move — merging is a human act. Opening a second review for the same branch pair fails with `review_already_open` and the id of the review that already exists: read that one instead of retrying.";
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    // Opening the same review twice is refused, so a client must not retry it as if it were safe.
    idempotentHint: false,
    openWorldHint: false,
  };

  constructor(private readonly proposals: ReviewProposalService) {}

  run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    return this.proposals.open(ctx.principal, {
      workflowId: args.workflow_id,
      sourceBranch: args.source_branch,
      targetBranch: args.target_branch,
      title: args.title,
      description: args.description ?? null,
    });
  }
}
