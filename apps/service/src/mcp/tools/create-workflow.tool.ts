import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { DomainError } from '../../common/domain-error';
import { PolicyService } from '../../policy/policy.service';
import { WorkflowLifecycleService } from '../../workflows/workflow-lifecycle.service';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('What this workflow is called. Also written into the saved document, so the two agree.'),
  workflow_ir: z
    .record(z.string(), z.unknown())
    .describe(
      'The v1 document — nodes, edges, settings. Run orchestr_validate on it first: whatever validate blocks, this refuses too.',
    ),
  description: z.string().max(2000).optional(),
  commit_message: z.string().max(500).optional().describe("Defaults to 'Initial version'."),
});

const Output = z.object({
  workflow_id: z.string(),
  name: z.string(),
  branch: z.string().describe('The default branch the version landed on.'),
  version_id: z.string().describe('Pass this as base_version_id on your next commit.'),
  version_number: z
    .number()
    .describe('Always 1 — the first version of the branch. Numbers are per-branch, never global.'),
  is_live: z
    .literal(false)
    .describe('A new workflow runs nowhere: no environment points at it and no trigger fires.'),
  ref_warnings: z.array(z.string()).describe('Data references that will not resolve at run time.'),
  next_step: z.string(),
});

@Injectable()
export class CreateWorkflowTool implements McpTool {
  readonly name = 'orchestr_create_workflow';
  readonly scope: ApiScope = 'workflow:write';
  readonly title = 'Create a workflow';
  readonly description =
    'Create a new workflow as a draft. It is saved, not live: nothing runs until a human publishes it. Version 1 lands on the default branch through the same commit path and author-time gate as every later version, so a document that would be refused at commit is refused here.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(
    private readonly lifecycle: WorkflowLifecycleService,
    private readonly policy: PolicyService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    const orgId = ctx.principal.activeOrgId;
    // Org membership decides inside an org; outside one, the caller owns what they create.
    const allowed = await this.policy.can(ctx.principal, 'write', {
      orgId,
      ownerUserId: orgId ? null : ctx.principal.user.id,
    });
    if (!allowed) throw new DomainError('Not authorised to create workflows in this organisation', 403);

    const created = await this.lifecycle.createDraft({
      principal: ctx.principal,
      name: args.name,
      description: args.description ?? null,
      irDoc: { ...args.workflow_ir, name: args.name },
      commitMessage: args.commit_message ?? null,
    });

    return {
      workflow_id: created.workflow.id,
      name: created.workflow.name,
      branch: created.branchName,
      version_id: created.version.id,
      version_number: created.version.versionNumber,
      is_live: false,
      ref_warnings: created.refWarnings,
      next_step: `Saved as version ${created.version.versionNumber} on '${created.branchName}'. Nothing runs yet: making it live is a separate act a person takes in Sarati, and no MCP tool can move an environment pointer.`,
    };
  }
}
