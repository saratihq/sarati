import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { DomainError } from '../../common/domain-error';
import {
  applyOpsDetailed,
  ApplyOpsError,
  emptyIr,
  MAX_OPS_PER_BATCH,
  parseOp,
} from '../../compose/apply-ops';
import { ComposeCatalogService } from '../../compose/compose-catalog.service';
import type { WorkflowIR } from '../../ir/models';
import type { McpCallContext, McpTool } from '../mcp-tool';
import { PlatformKeysService } from '../../platform/platform-keys.service';

/**
 * The vocabulary lives in the description, not in the input schema: the MCP runtime rejects a
 * schema mismatch as a PROTOCOL error, while `parseOp` is the one parser both this tool and
 * `POST /api/compose/apply-ops` use — so every mistake comes back as actionable `ops[i] …` text.
 */
const OPS_DOC = [
  'The batch to apply, in order. Each op is an object with an "op" field:',
  '- add_node {node:{id, node_type, name?, parameters?}} — `id` is a stable identifier YOU choose (letters, digits, _ or -) and never change; `node_type` must be an exact "type" from orchestr_search_actions.',
  '- update_node {node_id, name?, node_type?, parameters?, metadata?} — `parameters` shallow-MERGES, so send only the keys you are setting. Renaming keeps the node id. Only the trigger node may change node_type (which replaces its parameters).',
  '- unset_parameters {node_id, keys:[…]} — remove those parameter keys; the only way to clear a field.',
  '- connect {source_node_id, target_node_id, source_port?, port_type?} — port_type "main" (default, the flow), "tool" (bind the target as an agent tool), or "error" (runs when the source throws). source_port 0/1 picks an IF\'s then/else lane and applies to "main" only.',
  '- disconnect {source_node_id, target_node_id, source_port?, target_port?, port_type?} — remove ONE edge. An edge is identified by BOTH endpoints AND its lane and ports, so a "main" and an "error" edge between the same two nodes are different edges: name the port_type of the one you mean.',
  '- remove_node {node_id} — drops the node and every edge touching it. To REWIRE, use disconnect + connect: removing and re-adding a node destroys its identity, so the change reviews as an unrelated add and delete instead of a rewire.',
  "- set_meta {name?, description?} — names the DOCUMENT. It does NOT rename the workflow: committing this leaves the title in the user's workflow list unchanged.",
  `The batch is atomic — one bad op rejects all of them and names its index. Max ${MAX_OPS_PER_BATCH} ops per call.`,
].join('\n');

const Input = z.object({
  workflow_ir: z
    .record(z.string(), z.unknown())
    .describe(
      'The document to edit: a workflow document with nodes[] and edges[]. Pass what orchestr_get_workflow returned (its nodes and edges), what a previous orchestr_edit_workflow returned, or {"nodes":[],"edges":[]} to start from a blank graph.',
    ),
  ops: z.array(z.record(z.string(), z.unknown())).describe(OPS_DOC),
});

const Output = z.object({
  workflow_ir: z
    .record(z.string(), z.unknown())
    .describe(
      'The edited document. NOTHING was saved — pass this to orchestr_validate to check it, then to orchestr_commit to write it to a branch.',
    ),
  applied: z.array(z.string()).describe('What each op did, in the order the ops were given.'),
});

/** An agent assembles a document from a read projection; fill only what it could not know. */
function toDocument(raw: Record<string, unknown>): WorkflowIR {
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new DomainError(
      'workflow_ir must be a workflow document with nodes[] and edges[] arrays — build one from the nodes and edges orchestr_get_workflow returned, or pass {"nodes":[],"edges":[]} to start from a blank graph.',
      422,
    );
  }
  return { ...emptyIr(), ...raw };
}

@Injectable()
export class EditWorkflowTool implements McpTool {
  readonly name = 'orchestr_edit_workflow';
  readonly scope: ApiScope = 'workflow:write';
  readonly title = 'Edit a workflow document';
  readonly description =
    'Persists NOTHING: this returns the edited document and saves nothing — commit the result to save it. Applies a batch of graph operations (add, update, connect, disconnect, remove) to a workflow document and returns the new document plus a line per op saying what it did. Positions are computed for you. Validate the result with orchestr_validate before committing it.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(
    private readonly catalog: ComposeCatalogService,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { workflow_ir: raw, ops: rawOps } = Input.parse(input);
    if (rawOps.length === 0) throw new DomainError('ops must contain at least one operation.', 422);
    if (rawOps.length > MAX_OPS_PER_BATCH) {
      throw new DomainError(
        `${rawOps.length} ops is more than one edit — send at most ${MAX_OPS_PER_BATCH} per call and commit in steps.`,
        422,
      );
    }
    const document = toDocument(raw);
    const allowedTriggerTypes = await this.catalog.allowedTriggerTypes(
      await this.platformKeys.scopeFor(ctx.principal.user.id, ctx.principal.activeOrgId),
    );
    try {
      const ops = rawOps.map((op, index) => parseOp(op, index));
      const { ir, applied } = applyOpsDetailed(
        document,
        ops,
        this.catalog.allowedTypes(),
        allowedTriggerTypes,
      );
      return { workflow_ir: ir as unknown as Record<string, unknown>, applied };
    } catch (err) {
      // The op-indexed message is the point: it tells the agent WHICH op to fix.
      if (err instanceof ApplyOpsError) throw new DomainError(err.message, 422);
      throw err;
    }
  }
}
