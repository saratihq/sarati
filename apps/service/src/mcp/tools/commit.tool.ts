import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { DomainError } from '../../common/domain-error';
import { PolicyService } from '../../policy/policy.service';
import { EnvPointersService } from '../../workflows/env-pointers.service';
import { VersionsWriteService } from '../../workflows/versions-write.service';
import { WorkflowsReadService } from '../../workflows/workflows-read.service';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({
  workflow_id: z.uuid(),
  workflow_ir: z
    .record(z.string(), z.unknown())
    .describe(
      'The COMPLETE document to save — a commit replaces the branch head, it is never a patch. Run orchestr_validate on it first.',
    ),
  branch: z
    .string()
    .min(1)
    .describe(
      'The branch to append to. Version numbers are per-branch, so the branch is part of a version\'s identity — read it from orchestr_get_workflow rather than assuming "main".',
    ),
  base_version_id: z
    .uuid()
    .optional()
    .describe(
      'The version_id you edited from (orchestr_get_workflow → version_id). REQUIRED for API-key callers: without it a commit that landed meanwhile would be silently clobbered, so the server refuses.',
    ),
  message: z
    .string()
    .max(500)
    .optional()
    .describe('The commit message a human reads in the version history.'),
});

const Output = z.object({
  version_id: z.string(),
  version_number: z
    .number()
    .describe('Per-branch, never global: v3 on `main` and v3 on a feature branch are different versions.'),
  branch: z.string(),
  no_changes: z
    .boolean()
    .describe(
      'True when the document was content-equal to the head: no version was minted and `version_id` is the existing head.',
    ),
  ref_warnings: z.array(z.string()).describe('Data references that will not resolve at run time.'),
  is_live: z
    .literal(false)
    .describe(
      'Always false. A commit advances the branch head only; releasing is a separate human act (publish/promote) that no MCP scope can perform.',
    ),
  live_versions: z
    .array(z.object({ environment: z.string(), version_id: z.string(), version_number: z.number() }))
    .describe('What each environment is running right now — untouched by this commit.'),
});

@Injectable()
export class CommitTool implements McpTool {
  readonly name = 'orchestr_commit';
  readonly scope: ApiScope = 'workflow:write';
  readonly title = 'Commit a version to a branch';
  readonly description =
    "Append a version to a branch — the document you send REPLACES the branch head. Save is not live: this never moves an environment pointer, and the result names the versions still running. Send `base_version_id` (the head you read); if someone committed to that branch meanwhile the commit is refused, never merged for you — recover with a three-way merge mapped exactly: base = the version at base_version_id, ours = the NEW branch head (the other author's), theirs = your draft. Every field both sides changed is a conflict you must resolve yourself. Re-sending an unchanged document mints nothing.";
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(
    private readonly reads: WorkflowsReadService,
    private readonly writes: VersionsWriteService,
    private readonly envPointers: EnvPointersService,
    private readonly policy: PolicyService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    const wf = await this.reads.getWorkflowEntity(args.workflow_id);
    const allowed = await this.policy.can(ctx.principal, 'write', {
      orgId: wf.orgId,
      ownerUserId: wf.userId,
    });
    if (!allowed) throw new DomainError('Not authorised to access this workflow', 403);

    const { version, refWarnings, noChanges } = await this.writes.commit({
      workflowId: args.workflow_id,
      workflowIr: args.workflow_ir,
      branchName: args.branch,
      commitMessage: args.message ?? null,
      author: ctx.principal.user.name,
      actorId: ctx.principal.user.id,
      principal: ctx.principal,
      baseVersionId: args.base_version_id ?? null,
    });

    return {
      version_id: version.id,
      version_number: version.versionNumber,
      branch: args.branch,
      no_changes: noChanges ?? false,
      ref_warnings: refWarnings,
      is_live: false,
      live_versions: await this.envPointers.listPointers(wf),
    };
  }
}
