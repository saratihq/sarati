import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { isRecord } from '../../common/json-util';
import { WorkflowsReadService, type BranchView } from '../../workflows/workflows-read.service';
import type { McpCallContext, McpTool } from '../mcp-tool';
import { WorkflowAccessService } from '../../workflows/workflow-access.service';

const Input = z.object({
  workflow_id: z.string(),
  branch: z.string().optional().describe("Defaults to the workflow's default branch."),
});

const Branch = z.object({
  name: z.string(),
  is_default: z.boolean(),
  is_protected: z.boolean(),
  head_version_id: z.string().nullable(),
});

const Output = z.object({
  workflow: z.object({ id: z.string(), name: z.string() }),
  branch: Branch,
  version_id: z.string().nullable(),
  version_number: z.number().nullable().describe('Version numbers are per-branch, never global.'),
  // Listed before the other arrays so the result-size cap trims the graph, not the orientation.
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      node_type: z.string(),
      type_version: z.number(),
      parameters: z.record(z.string(), z.unknown()),
      metadata: z.record(z.string(), z.unknown()),
      /** Layout, carried so an edit round-trip does not relayout the whole canvas. */
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source_node_id: z.string(),
      source_port: z.number(),
      target_node_id: z.string(),
      target_port: z.number(),
      port_type: z.string(),
    }),
  ),
  branches: z.array(Branch),
  live_versions: z.array(
    z.object({ environment: z.string(), version_id: z.string(), version_number: z.number() }),
  ),
});

type WorkflowView = z.infer<typeof Output>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The node as stored, minus the credentials block — a connection is referenced by id in `parameters`.
 * Everything else round-trips, so a read → edit → commit loop cannot silently drop a node's layout.
 */
function nodeView(raw: Record<string, unknown>): WorkflowView['nodes'][number] {
  const position = record(raw.position);
  return {
    id: str(raw.id),
    name: str(raw.name),
    node_type: str(raw.node_type),
    type_version: num(raw.type_version) || 1,
    parameters: record(raw.parameters),
    metadata: record(raw.metadata),
    position: { x: num(position.x), y: num(position.y) },
  };
}

/** The read path already normalized these; edge identity is the endpoint tuple incl. `port_type` (invariant #13). */
function edgeView(raw: Record<string, unknown>): WorkflowView['edges'][number] {
  return {
    id: str(raw.id),
    source_node_id: str(raw.source_node_id),
    source_port: num(raw.source_port),
    target_node_id: str(raw.target_node_id),
    target_port: num(raw.target_port),
    port_type: str(raw.port_type),
  };
}

function branchOut(branch: BranchView): z.infer<typeof Branch> {
  return {
    name: branch.name,
    is_default: branch.is_default,
    is_protected: branch.is_protected,
    head_version_id: branch.head_version_id,
  };
}

@Injectable()
export class GetWorkflowTool implements McpTool {
  readonly name = 'orchestr_get_workflow';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Get a workflow';
  readonly description =
    'The editable head of a branch plus everything needed to reason about it: nodes, edges, branches and which versions are live. Node credentials are never returned.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(
    private readonly reads: WorkflowsReadService,
    private readonly access: WorkflowAccessService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<WorkflowView> {
    const { workflow_id: workflowId, branch } = Input.parse(input);
    await this.access.require(ctx.principal, workflowId, 'read');

    const view = await this.reads.getBranchHead(workflowId, branch ?? null);
    return {
      workflow: { id: view.workflow_id, name: view.workflow_name },
      branch: branchOut(view.branch),
      version_id: view.head?.version_id ?? null,
      version_number: view.head?.version_number ?? null,
      nodes: (view.head?.nodes ?? []).map(nodeView),
      edges: (view.head?.edges ?? []).map(edgeView),
      branches: view.branches.map(branchOut),
      live_versions: view.env_pointers,
    };
  }
}
