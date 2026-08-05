import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { BranchService } from '../../workflows/branch.service';
import { WorkflowsReadService } from '../../workflows/workflows-read.service';
import type { McpCallContext, McpTool } from '../mcp-tool';
import { WorkflowAccessService } from '../../workflows/workflow-access.service';

const Input = z.object({
  workflow_id: z.uuid(),
  name: z.string().trim().min(1).max(100).describe('Branch name, unique within the workflow.'),
  from_version_id: z
    .uuid()
    .optional()
    .describe(
      "Fork point; defaults to the default branch's head. Version NUMBERS are per-branch and are never accepted here.",
    ),
});

const Output = z.object({
  workflow_id: z.string(),
  branch: z.object({
    name: z.string(),
    is_default: z.literal(false),
    is_protected: z.boolean(),
  }),
  fork_point: z
    .object({
      version_id: z.string(),
      version_number: z.number(),
      branch: z.string().nullable(),
    })
    .nullable()
    .describe(
      'The version this branch INHERITS, numbered in the branch it came from. It was not copied and not renumbered — null when the workflow has no version yet.',
    ),
  next_version_number: z
    .literal(1)
    .describe(
      "Your first commit here is version 1, whatever number the fork point carries: numbers are per-branch, so this branch's v1 is not the default branch's v1.",
    ),
  is_live: z
    .literal(false)
    .describe('A branch is never live. Nothing committed here runs until it is merged and published.'),
  next_step: z.string(),
});

@Injectable()
export class CreateBranchTool implements McpTool {
  readonly name = 'orchestr_create_branch';
  readonly scope: ApiScope = 'workflow:write';
  readonly title = 'Create a branch';
  readonly description =
    'Branch a workflow so changes can be proposed without touching main. The branch starts at the version it forks from — that version is inherited, not copied — and its own first commit is version 1, because version numbers are per-branch.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    // Creating the same branch twice is refused, so a client must not retry it as if it were safe.
    idempotentHint: false,
    openWorldHint: false,
  };

  constructor(
    private readonly branches: BranchService,
    private readonly reads: WorkflowsReadService,
    private readonly access: WorkflowAccessService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    const wf = await this.access.require(ctx.principal, args.workflow_id, 'write');

    const branch = await this.branches.createBranch(
      wf.id,
      args.name,
      args.from_version_id ?? null,
      ctx.principal.user.id,
    );
    const forkPoint = branch.headVersionId
      ? await this.branches.forkPointOf(wf.id, branch.headVersionId)
      : null;

    return {
      workflow_id: wf.id,
      branch: { name: branch.name, is_default: false, is_protected: branch.isProtected },
      fork_point: forkPoint,
      next_version_number: 1,
      is_live: false,
      next_step: `Commit your changes to '${branch.name}', then open a review so a person can merge and publish them.`,
    };
  }
}
