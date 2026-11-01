import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { WorkflowAccessService } from '../../workflows/workflow-access.service';
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
    .describe('Always false: no environment points at a new workflow, so no trigger fires it.'),
  ref_warnings: z.array(z.string()).describe('Data references that will not resolve at run time.'),
  next_step: z.string(),
});

@Injectable()
export class CreateWorkflowTool implements McpTool {
  readonly name = 'orchestr_create_workflow';
  readonly scope: ApiScope = 'workflow:write';
  readonly title = 'Create a workflow';
  readonly description =
    'Create a new workflow as a draft. It is saved, not live: no trigger fires it and no published-tool or sub-workflow call reaches it until it is published or promoted, which no MCP tool does; a test run (orchestr_test_workflow) can still run it on demand. Version 1 lands on the default branch through the same commit path and author-time gate as every later version, so a document that would be refused at commit is refused here.';
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
    private readonly access: WorkflowAccessService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const args = Input.parse(input);
    await this.access.requireCreate(ctx.principal, 'write');

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
      next_step: `Saved as version ${created.version.versionNumber} on '${created.branchName}'. Not live yet: no trigger fires it and no published-tool or sub-workflow call reaches it until it is published or promoted, and no MCP tool can move an environment pointer.`,
    };
  }
}
