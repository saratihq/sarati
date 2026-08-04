import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { validateAuthoredIr } from '../../compose/author-validation';
import { ComposeCatalogService } from '../../compose/compose-catalog.service';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({
  workflow_ir: z.record(z.string(), z.unknown()).describe('The document to check. Nothing is saved.'),
  workflow_id: z
    .string()
    .optional()
    .describe(
      'The workflow this document belongs to. Pass it whenever you have it — without it a self-referential sub-workflow call cannot be detected, and the document would still be refused at commit.',
    ),
});

const Issue = z.object({
  code: z.string(),
  message: z.string(),
  node_id: z.string().optional(),
  node_name: z.string().optional(),
  node_type: z.string().optional(),
});

const Output = z.object({
  valid: z.boolean().describe('False when a commit would be refused.'),
  errors: z.array(Issue).describe('Blocking: fix every one of these before committing.'),
  warnings: z
    .array(Issue)
    .describe('Advisory: real problems the engine tolerates, so they never block a commit.'),
  ref_warnings: z.array(z.string()).describe('Data references that will not resolve at run time.'),
  unconfigured_connections: z
    .array(
      z.object({
        node_id: z.string(),
        node_name: z.string(),
        node_type: z.string(),
        auth: z.string(),
      }),
    )
    .describe(
      'Steps needing a credential that carry no connectionId. A dry run deliberately does not catch these (ADR 0041), so this is the only warning before the first real fire — set parameters.connectionId from orchestr_list_connections.',
    ),
});

@Injectable()
export class ValidateTool implements McpTool {
  readonly name = 'orchestr_validate';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Validate a workflow document';
  readonly description =
    'Will this document commit, compile and actually run? Returns blocking errors, advisory warnings, broken data references, and every step missing its connection. Persists nothing — call it before committing.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(private readonly catalog: ComposeCatalogService) {}

  run(input: unknown, _ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { workflow_ir: ir, workflow_id: workflowId } = Input.parse(input);
    const report = validateAuthoredIr(ir, this.catalog.facts(), workflowId);
    return Promise.resolve({
      valid: report.valid,
      errors: report.errors,
      warnings: report.warnings,
      ref_warnings: report.ref_warnings,
      unconfigured_connections: report.unconfigured_connections.map((req) => ({
        node_id: req.node_id,
        node_name: req.node_name,
        node_type: req.node_type,
        auth: req.auth,
      })),
    });
  }
}
