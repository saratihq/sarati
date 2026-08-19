import { isTriggerNode } from '../compiler/compile-ir';
import { compileWorkflowIrDag, ROUTED_PORT_TYPES } from '../compiler/compile-ir-dag';
import { lintDataRefs } from '../compiler/ref-lint';
import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { isRecord } from '../common/json-util';
import { edgePortType, type WorkflowIR } from '../ir/models';
import { isRoutableActionType } from '../providers/sdk-actions.registry';

/** A node id is a caller-assigned stable identifier (invariant #13) — this is its ONE format rule. */
export const NODE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

/** The minimum a node must show to be categorised: its type, plus the app-trigger marker. */
type CategorizableNode = Pick<DocNode, 'node_type'> & { metadata?: Record<string, unknown> };

/**
 * A node's category. "Is it a trigger?" is NOT re-answered here — `isTriggerNode` is the ONE
 * definition site, so the whole family (`orchestr:tool_trigger`, any `*trigger` type, a
 * `metadata.trigger` app trigger) categorises exactly as the compiler peels it. Every other match
 * is on the EXACT `orchestr:*` type, never a substring: an app action merely CONTAINING "if"/"set"
 * (slack.set_topic, github.merge_pull_request) is a plain action.
 */
export function getNodeCategory(nodeType: string, metadata?: Record<string, unknown>): string {
  if (isTriggerNode({ node_type: nodeType, ...(metadata ? { metadata } : {}) })) return 'trigger';
  if (nodeType === 'orchestr:agent') return 'action';
  if (nodeType === 'orchestr:if' || nodeType === 'orchestr:switch' || nodeType === 'orchestr:loop') {
    return 'logic';
  }
  if (nodeType === 'orchestr:code') return 'transform';
  return 'action';
}

/** Can a `port_type:'tool'` edge bind this target as an agent tool (invariant #14)? */
export function isToolEligibleTarget(node: CategorizableNode): boolean {
  return node.node_type !== 'orchestr:agent' && getNodeCategory(node.node_type, node.metadata) === 'action';
}

/** One thing wrong with a document, named precisely enough for a caller to fix it. */
export interface ValidationError {
  code: string;
  message: string;
  node_id?: string;
  node_name?: string;
  node_type?: string;
}

/** A node whose type needs a credential, and whether the step actually carries one. */
export interface ConnectionRequirement {
  node_id: string;
  node_name: string;
  node_type: string;
  auth: string;
  configured: boolean;
}

/** The full answer to "will this commit, compile and actually run?". */
export interface ValidationReport {
  valid: boolean;
  /** Blocking: a commit carrying any of these is refused. */
  errors: ValidationError[];
  /** Advisory: real problems the engine tolerates, so they never block history. */
  warnings: ValidationError[];
  ref_warnings: string[];
  unconfigured_connections: ConnectionRequirement[];
}

/** What the catalog knows about a type; supplied by the caller so this module stays free of DI. */
export interface CatalogFacts {
  controlTypes: ReadonlySet<string>;
  /** The auth requirement declared for a type — `'none'` when it needs no credential. */
  authOf(nodeType: string): string;
  /** Whether the type is a TRIGGER in this instance's catalog — the diagnosis for an unmarked one. */
  isTriggerType(nodeType: string): boolean;
}

interface DocNode {
  id: string;
  name: string;
  node_type: string;
  parameters: Record<string, unknown>;
  /** RAW, never defaulted: the gate's job is to say whether the author supplied a usable one. */
  position: unknown;
  metadata?: Record<string, unknown>;
}

function nodesOf(ir: Record<string, unknown>): DocNode[] {
  const raw = Array.isArray(ir.nodes) ? (ir.nodes as Record<string, unknown>[]) : [];
  return raw.filter(isRecord).map((node) => ({
    id: typeof node.id === 'string' ? node.id : '',
    name: typeof node.name === 'string' ? node.name : '',
    node_type: typeof node.node_type === 'string' ? node.node_type : '',
    parameters: isRecord(node.parameters) ? node.parameters : {},
    position: node.position,
    metadata: isRecord(node.metadata) ? node.metadata : undefined,
  }));
}

/** A drawable, diffable coordinate: both axes present and finite. */
function hasUsablePosition(position: unknown): boolean {
  if (!isRecord(position)) return false;
  return [position.x, position.y].every((v) => typeof v === 'number' && Number.isFinite(v));
}

function edgesOf(ir: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(ir.edges) ? (ir.edges as Record<string, unknown>[]) : [];
}

function checkNodes(
  nodes: DocNode[],
  facts: CatalogFacts,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!NODE_ID_RE.test(node.id)) {
      errors.push({
        code: 'invalid_node_id',
        node_id: node.id,
        node_name: node.name,
        message: `Node id "${node.id}" is invalid — use a short identifier (letters, digits, _ or -, max 60 chars).`,
      });
    }
    if (seen.has(node.id)) {
      errors.push({
        code: 'duplicate_node_id',
        node_id: node.id,
        message: `Two nodes share the id "${node.id}" — ids are identity, so they must be unique.`,
      });
    }
    seen.add(node.id);

    // Layout is presentation, not history — the engine runs such a node fine, so this never blocks.
    if (!hasUsablePosition(node.position)) {
      warnings.push({
        code: 'invalid_node_position',
        node_id: node.id,
        node_name: node.name,
        message: `Node "${node.id}" has no usable canvas position — set "position": {"x": <finite number>, "y": <finite number>}, or every such node stacks at the canvas origin.`,
      });
    }

    if (!node.node_type) {
      errors.push({
        code: 'missing_node_type',
        node_id: node.id,
        node_name: node.name,
        message: `Node "${node.id}" has no node_type.`,
      });
      continue;
    }
    if (isTriggerNode(node) || facts.controlTypes.has(node.node_type)) continue;
    if (facts.isTriggerType(node.node_type)) {
      errors.push({
        code: 'trigger_not_marked',
        node_id: node.id,
        node_name: node.name,
        node_type: node.node_type,
        message: `Node "${node.id}" has the trigger type "${node.node_type}", but nothing marks it as this workflow's trigger — add "metadata": {"trigger": true} to the node. Without the marker it is treated as a step, and no step runs "${node.node_type}".`,
      });
      continue;
    }
    if (!isRoutableActionType(node.node_type)) {
      errors.push({
        code: 'unresolvable_node_type',
        node_id: node.id,
        node_name: node.name,
        node_type: node.node_type,
        message: `Node "${node.id}" has an unrecognized type "${node.node_type}" that isn't in the catalog — it can't run (likely a removed or renamed action).`,
      });
    }
  }
}

function checkTriggers(nodes: DocNode[], errors: ValidationError[]): void {
  const triggers = nodes.filter((node) => isTriggerNode(node));
  if (triggers.length > 1) {
    errors.push({
      code: 'multiple_triggers',
      message: `A workflow has at most one trigger; this document has ${triggers.length} (${triggers.map((t) => t.id).join(', ')}). The compiler peels them all, so the extra ones would silently never fire.`,
    });
  }
}

function checkEdges(
  nodes: DocNode[],
  edges: Record<string, unknown>[],
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const source = typeof edge.source_node_id === 'string' ? edge.source_node_id : '';
    const target = typeof edge.target_node_id === 'string' ? edge.target_node_id : '';
    // The SAME lane rule the compiler routes by — an absent `port_type` is the main lane.
    const portType = edgePortType(edge);

    if (!ROUTED_PORT_TYPES.has(portType)) {
      errors.push({
        code: 'unknown_edge_port_type',
        node_id: source,
        message: `The edge "${source}" → "${target}" rides lane "${portType}", which nothing routes — use "main" (the flow), "error" (the error lane) or "tool" (an agent tool binding). The compiler drops an edge on any other lane silently.`,
      });
    }

    for (const [end, id] of [
      ['source', source],
      ['target', target],
    ] as const) {
      if (!byId.has(id)) {
        warnings.push({
          code: 'dangling_edge',
          node_id: id,
          message: `An edge names a ${end} node "${id}" that does not exist — the compiler drops such an edge silently, so the step would never run.`,
        });
      }
    }
    if (source && source === target) {
      errors.push({
        code: 'self_edge',
        node_id: source,
        message: `Node "${source}" is connected to itself.`,
      });
    }
    const targetNode = byId.get(target);
    if (portType === 'tool' && targetNode && !isToolEligibleTarget(targetNode)) {
      errors.push({
        code: 'tool_edge_ineligible_target',
        node_id: target,
        node_name: targetNode.name,
        message: `A tool edge's target must be an action the agent can call — "${target}" (${targetNode.node_type}) isn't tool-eligible.`,
      });
    }
  }
}

function checkCompiles(
  ir: Record<string, unknown>,
  workflowId: string | undefined,
  errors: ValidationError[],
): void {
  if (!Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) return;
  try {
    compileWorkflowIrDag(ir as unknown as WorkflowIR, workflowId);
  } catch (err) {
    const details = err instanceof DomainError ? (err.details ?? {}) : {};
    errors.push({
      code: 'invalid_workflow_structure',
      message: errorMessage(err),
      ...(typeof details.node_id === 'string' ? { node_id: details.node_id } : {}),
    });
  }
}

/** Every node whose type needs a credential — the ONE answer to "is this step's auth wired up?". */
export function connectionRequirements(
  ir: Record<string, unknown>,
  facts: CatalogFacts,
): ConnectionRequirement[] {
  return nodesOf(ir)
    .map((node) => ({ node, auth: facts.authOf(node.node_type) }))
    .filter(({ auth }) => auth !== 'none')
    .map(({ node, auth }) => ({
      node_id: node.id,
      node_name: node.name,
      node_type: node.node_type,
      auth,
      configured: Boolean(node.parameters.connectionId),
    }));
}

/** The subset that will 422 on its first real fire — a dry run deliberately does not catch these. */
export function unconfiguredConnections(
  ir: Record<string, unknown>,
  facts: CatalogFacts,
): ConnectionRequirement[] {
  return connectionRequirements(ir, facts).filter((req) => !req.configured);
}

/**
 * The ONE author-time gate — every path that PERSISTS a document runs it: `commit`
 * (`versions-write.service.ts`), the two create paths (`workflow-lifecycle.service.ts`), and the
 * read-only `orchestr_validate` tool, so a hand-written document faces exactly what an ops-built
 * one does. `apply_ops` deliberately does NOT run it — it mutates a DRAFT mid-composition, where a
 * half-wired document is expected; it enforces the per-op subset instead, through the predicates
 * exported here (`NODE_ID_RE`, `isToolEligibleTarget`), never a second copy of them.
 * Whatever this accepts, the compiler must compile WHOLE: an edge or node it lets through and the
 * compiler then drops is the defect, not the document.
 * `workflowId` lets the compiler's self-referential `call_workflow` guard fire; omit it and a
 * document that 422s at commit would validate clean (the create paths have no id yet, so they can't).
 */
export function validateAuthoredIr(
  ir: Record<string, unknown>,
  facts: CatalogFacts,
  workflowId?: string,
): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const nodes = nodesOf(ir);

  checkNodes(nodes, facts, errors, warnings);
  checkTriggers(nodes, errors);
  checkEdges(nodes, edgesOf(ir), errors, warnings);
  checkCompiles(ir, workflowId, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ref_warnings: lintDataRefs(ir),
    unconfigured_connections: unconfiguredConnections(ir, facts),
  };
}

/** The commit path's face: the first error becomes a 422 carrying its machine code. */
export function assertAuthoredIrValid(
  ir: Record<string, unknown>,
  facts: CatalogFacts,
  workflowId?: string,
): ValidationReport {
  const report = validateAuthoredIr(ir, facts, workflowId);
  const first = report.errors[0];
  if (first) {
    throw new DomainError(first.message, 422, {
      code: first.code,
      ...(first.node_id ? { node_id: first.node_id } : {}),
      ...(first.node_type ? { node_type: first.node_type } : {}),
      errors: report.errors,
    });
  }
  return report;
}
