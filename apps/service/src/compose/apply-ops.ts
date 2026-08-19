import { isRecord } from '../common/json-util';
import { isTriggerNode } from '../compiler/compile-ir';
import { sameEdgeEndpoints, type EdgeEndpoints } from '../ir/diff';
import { isToolEligibleTarget, NODE_ID_RE } from './author-validation';
import type { IREdge, IRNode, WorkflowIR } from '../ir/models';
import { cloneIr, emptySettings, MAIN_PORT_TYPE } from '../ir/models';

/**
 * Batched graph operations against a DRAFT WorkflowIR — the composer agent's mutation surface.
 * Ops apply atomically: the first invalid op rejects the whole batch with an error string echoed
 * back to the agent verbatim. Positions are computed HERE, never by the LLM — existing nodes keep
 * their coordinates and new ones are placed downstream of their upstream node.
 */

export type ComposeOp =
  | {
      op: 'add_node';
      node: { id: string; name?: string; node_type: string; parameters?: Record<string, unknown> };
    }
  | {
      op: 'update_node';
      node_id: string;
      name?: string;
      node_type?: string;
      parameters?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | {
      op: 'connect';
      source_node_id: string;
      target_node_id: string;
      source_port?: number;
      /** `main` (default; a step in the flow), `tool` (bind the target as an agent tool), or `error` (the error lane). */
      port_type?: ConnectPortType;
    }
  | {
      /** Remove ONE edge, keyed on the full endpoint tuple incl. `port_type` (invariant #13). */
      op: 'disconnect';
      source_node_id: string;
      target_node_id: string;
      source_port?: number;
      target_port?: number;
      port_type?: ConnectPortType;
    }
  | { op: 'unset_parameters'; node_id: string; keys: string[] }
  | { op: 'set_meta'; name?: string; description?: string }
  | { op: 'remove_node'; node_id: string };

/** The edge lanes the composer can wire (mirrors the client's canvas handles). */
export type ConnectPortType = 'main' | 'tool' | 'error';

/** The vocabulary, named once — both the unknown-op parse error and the unknown-op apply error quote it. */
const OP_NAMES = 'add_node, update_node, connect, disconnect, unset_parameters, set_meta, remove_node';

/** One batch is one atomic edit; a bigger change is several calls, not one unreviewable blob. */
export const MAX_OPS_PER_BATCH = 50;

/** Thrown per invalid op — message is agent-facing, keep it actionable. */
export class ApplyOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyOpsError';
  }
}

// Canvas grid — must stay in lockstep with the client's flowLayout constants.
const X_PITCH = 300;
const Y_PITCH = 130;
const X0 = 60;
const CENTER_Y = 300;

const TRIGGER_TYPE = 'orchestr:trigger';
const MAX_NODE_NAME = 80;
/** `workflows.name` is varchar(255) — a document name that could never become one is a trap. */
const MAX_DOC_NAME = 255;
const MAX_LISTED_EDGES = 10;

/** App/polling triggers (`gmail.new_email`) carry the metadata.trigger marker; native kinds don't. */
function isAppTrigger(type: string): boolean {
  return !type.startsWith('orchestr:');
}

export function emptyIr(name = 'New workflow'): WorkflowIR {
  return {
    version: '1',
    name,
    description: '',
    nodes: [],
    edges: [],
    settings: emptySettings(),
    metadata: { engine: 'orchestr' },
  };
}

/**
 * The edge id for a wire — must stay byte-identical to the client's `irGraph.addIrEdge`. The lane
 * infix keeps a tool/error edge from colliding with a `main` edge between the same pair (invariant
 * #4 / constitution rows 12/14), and `-p{port}-` keeps an IF's two ports into one join distinct.
 */
function edgeId(source: string, port: number, target: string, portType: ConnectPortType): string {
  if (portType === 'error') return `e-${source}-err-${target}`;
  if (portType === 'tool') return `e-${source}-tool-${target}`;
  return port > 0 ? `e-${source}-p${port}-${target}` : `e-${source}-${target}`;
}

/** How an edge is spoken about in an op-facing message: `main "a"[0] → "b"[0]`. */
function edgeLabel(edge: EdgeEndpoints): string {
  return `${edge.port_type ?? 'main'} "${edge.source_node_id}"[${edge.source_port}] → "${edge.target_node_id}"[${edge.target_port}]`;
}

function listEdges(ir: WorkflowIR): string {
  if (ir.edges.length === 0) return '(none)';
  const shown = ir.edges.slice(0, MAX_LISTED_EDGES).map(edgeLabel);
  const hidden = ir.edges.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} (+${hidden} more)` : shown.join(', ');
}

function keyList(record: Record<string, unknown>): string {
  return Object.keys(record).join(', ') || '(none)';
}

function nodeIndex(ir: WorkflowIR, nodeId: string): number {
  return ir.nodes.findIndex((n) => n.id === nodeId);
}

function requireNode(ir: WorkflowIR, nodeId: string, op: string): IRNode {
  const node = ir.nodes.find((n) => n.id === nodeId);
  if (!node) {
    const ids = ir.nodes.map((n) => n.id).join(', ') || '(none)';
    throw new ApplyOpsError(`${op}: no node with id "${nodeId}" — existing node ids: ${ids}`);
  }
  return node;
}

/** What one op is allowed to do, and where a node that still needs a layout slot is collected. */
interface ApplyContext {
  allowedTypes: ReadonlySet<string>;
  allowedTriggerTypes: ReadonlySet<string>;
  unplaced: Set<string>;
}

function applyAddNode(ir: WorkflowIR, op: Extract<ComposeOp, { op: 'add_node' }>, ctx: ApplyContext): string {
  const { id, node_type: nodeType } = op.node;
  if (!NODE_ID_RE.test(id)) {
    throw new ApplyOpsError(
      `add_node: node id "${id}" is invalid — use a short snake_case identifier (letters, digits, _ or -, max 60 chars)`,
    );
  }
  if (nodeIndex(ir, id) >= 0) {
    throw new ApplyOpsError(
      `add_node: a node with id "${id}" already exists — pick a new id or use update_node`,
    );
  }
  if (!ctx.allowedTypes.has(nodeType)) {
    throw new ApplyOpsError(
      `add_node "${id}": unknown action type "${nodeType}" — use search_catalog and copy the exact "type" value of a listed action`,
    );
  }
  if (nodeType === TRIGGER_TYPE && ir.nodes.some((n) => n.node_type === TRIGGER_TYPE)) {
    throw new ApplyOpsError(
      `add_node "${id}": the workflow already has a trigger node — update or remove it instead`,
    );
  }
  ir.nodes.push({
    id,
    name: op.node.name?.trim().slice(0, MAX_NODE_NAME) || prettify(id),
    node_type: nodeType,
    type_version: 1,
    parameters: op.node.parameters ?? {},
    position: { x: 0, y: 0 }, // placeholder — layoutNewNodes assigns the real slot
    // App triggers are only recognizable by this marker (their type looks like an action's).
    metadata: isAppTrigger(nodeType) && ctx.allowedTriggerTypes.has(nodeType) ? { trigger: true } : {},
  });
  ctx.unplaced.add(id);
  return `added node "${id}" (${nodeType})`;
}

/**
 * Only the trigger node changes its type — an action's type is its identity, so re-add it instead.
 * The trigger node is where a workflow's start kind is chosen, and re-typing REPLACES
 * parameters so the new kind never inherits the previous kind's props.
 */
function retypeNode(
  node: IRNode,
  nextType: string,
  parameters: Record<string, unknown> | undefined,
  allowedTriggerTypes: ReadonlySet<string>,
): string {
  if (!isTriggerNode(node)) {
    throw new ApplyOpsError(
      `update_node "${node.id}": only the trigger node can change its type — remove and re-add an action to change it`,
    );
  }
  if (!allowedTriggerTypes.has(nextType)) {
    throw new ApplyOpsError(
      `update_node "${node.id}": "${nextType}" is not a known trigger type — search the catalog with kind: "trigger" and copy an exact "type", or use orchestr:trigger | orchestr:webhook | orchestr:schedule | orchestr:chat`,
    );
  }
  node.node_type = nextType;
  // Mirror the client picker: app triggers carry metadata.trigger; native kinds clear it.
  const meta = isRecord(node.metadata) ? { ...node.metadata } : {};
  if (isAppTrigger(nextType)) meta.trigger = true;
  else delete meta.trigger;
  node.metadata = meta;
  node.parameters = parameters ?? {};
  return `retyped to "${nextType}" (parameters replaced)`;
}

function applyUpdateNode(
  ir: WorkflowIR,
  op: Extract<ComposeOp, { op: 'update_node' }>,
  allowedTriggerTypes: ReadonlySet<string>,
): string {
  const node = requireNode(ir, op.node_id, 'update_node');
  const changes: string[] = [];
  if (op.node_type !== undefined && op.node_type !== node.node_type) {
    changes.push(retypeNode(node, op.node_type, op.parameters, allowedTriggerTypes));
  } else if (op.parameters !== undefined) {
    // Shallow-merge: the agent sends only the keys it wants to set.
    node.parameters = { ...node.parameters, ...op.parameters };
    changes.push(`set parameters ${keyList(op.parameters)}`);
  }
  if (op.name !== undefined) {
    const trimmed = op.name.trim().slice(0, MAX_NODE_NAME);
    if (trimmed) {
      node.name = trimmed;
      changes.push(`renamed to "${trimmed}"`);
    }
  }
  if (op.metadata !== undefined) {
    const base = isRecord(node.metadata) ? node.metadata : {};
    node.metadata = { ...base, ...op.metadata };
    changes.push(`set metadata ${keyList(op.metadata)}`);
  }
  return changes.length > 0
    ? `updated node "${op.node_id}": ${changes.join('; ')}`
    : `updated node "${op.node_id}": nothing to change`;
}

function applyConnect(ir: WorkflowIR, op: Extract<ComposeOp, { op: 'connect' }>): string {
  requireNode(ir, op.source_node_id, 'connect');
  const target = requireNode(ir, op.target_node_id, 'connect');
  if (op.source_node_id === op.target_node_id) {
    throw new ApplyOpsError(`connect: cannot connect node "${op.source_node_id}" to itself`);
  }
  const portType = op.port_type ?? MAIN_PORT_TYPE;
  // Only a MAIN edge selects an output port (0 = main/then, 1 = else on an IF); a
  // tool/error edge leaves a SINGLE source handle, so its source_port is always 0.
  let port: number;
  if (portType === MAIN_PORT_TYPE) {
    port = op.source_port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 1) {
      throw new ApplyOpsError(
        `connect: source_port must be 0 (main/then) or 1 (else) — got ${String(op.source_port)}`,
      );
    }
  } else {
    if (op.source_port !== undefined && op.source_port !== 0) {
      throw new ApplyOpsError(
        `connect: a ${portType} edge leaves a single handle — omit source_port (or use 0), got ${String(op.source_port)}`,
      );
    }
    port = 0;
  }
  // Reject an ineligible tool edge at author time rather than letting it 422 at compile.
  if (portType === 'tool' && !isToolEligibleTarget(target)) {
    throw new ApplyOpsError(
      `connect: a tool edge's target must be an action the agent can call (an action node or an orchestr:call_workflow) — "${op.target_node_id}" (${target.node_type}) isn't tool-eligible; wire an action to the agent's tools handle instead`,
    );
  }
  const edge: IREdge = {
    id: edgeId(op.source_node_id, port, op.target_node_id, portType),
    source_node_id: op.source_node_id,
    source_port: port,
    target_node_id: op.target_node_id,
    target_port: 0,
    port_type: portType,
  };
  // Idempotent — re-connecting the same endpoint tuple is a no-op.
  if (ir.edges.some((e) => sameEdgeEndpoints(e, edge))) return `${edgeLabel(edge)} was already connected`;
  ir.edges.push(edge);
  return `connected ${edgeLabel(edge)}`;
}

/**
 * Remove ONE edge by its endpoint TUPLE including `port_type` (invariant #13): an edge `id` is a
 * label, not identity — a stored document can carry a main and an error edge between the same pair
 * under the SAME id, so keying removal by id would collapse both lanes.
 */
function applyDisconnect(ir: WorkflowIR, op: Extract<ComposeOp, { op: 'disconnect' }>): string {
  const wanted: EdgeEndpoints = {
    source_node_id: op.source_node_id,
    source_port: op.source_port ?? 0,
    target_node_id: op.target_node_id,
    target_port: op.target_port ?? 0,
    port_type: op.port_type ?? 'main',
  };
  const index = ir.edges.findIndex((e) => sameEdgeEndpoints(e, wanted));
  if (index < 0) {
    throw new ApplyOpsError(
      `disconnect: no edge matching ${edgeLabel(wanted)} — the lane and the ports are part of an edge's identity, so name the ones you mean. Existing edges: ${listEdges(ir)}`,
    );
  }
  ir.edges.splice(index, 1);
  return `disconnected ${edgeLabel(wanted)}`;
}

function applyUnsetParameters(ir: WorkflowIR, op: Extract<ComposeOp, { op: 'unset_parameters' }>): string {
  const node = requireNode(ir, op.node_id, 'unset_parameters');
  const parameters = isRecord(node.parameters) ? node.parameters : {};
  const cleared: string[] = [];
  const absent: string[] = [];
  for (const key of op.keys) {
    if (key in parameters) {
      delete parameters[key];
      cleared.push(key);
    } else {
      absent.push(key);
    }
  }
  node.parameters = parameters;
  const tail = absent.length > 0 ? `; already unset: ${absent.join(', ')}` : '';
  return `cleared parameters on "${op.node_id}": ${cleared.join(', ') || '(none)'}${tail}`;
}

/**
 * Names the DOCUMENT, never the workflow row: `commit` writes a version and leaves `workflows.name`
 * alone, so a rename here is invisible in the user's workflow list until `PUT /api/workflows/:id`.
 */
function applySetMeta(ir: WorkflowIR, op: Extract<ComposeOp, { op: 'set_meta' }>): string {
  const changes: string[] = [];
  if (op.name !== undefined) {
    const trimmed = op.name.trim().slice(0, MAX_DOC_NAME);
    if (!trimmed) throw new ApplyOpsError('set_meta: name must not be blank');
    ir.name = trimmed;
    changes.push(`name to "${trimmed}"`);
  }
  if (op.description !== undefined) {
    ir.description = op.description.trim();
    changes.push('description');
  }
  return `set the document's ${changes.join(' and ')} — this renames the DOCUMENT only, NOT the workflow itself, whose title a commit never changes`;
}

function applyRemoveNode(
  ir: WorkflowIR,
  op: Extract<ComposeOp, { op: 'remove_node' }>,
  unplaced: Set<string>,
): string {
  requireNode(ir, op.node_id, 'remove_node');
  const before = ir.edges.length;
  ir.nodes = ir.nodes.filter((n) => n.id !== op.node_id);
  ir.edges = ir.edges.filter((e) => e.source_node_id !== op.node_id && e.target_node_id !== op.node_id);
  unplaced.delete(op.node_id);
  return `removed node "${op.node_id}" and ${before - ir.edges.length} edge(s) touching it`;
}

/**
 * Place the still-unplaced nodes on the grid: downstream of their upstream node, upstream of their
 * target when only an outgoing edge exists, else after the rightmost node. A node that already has
 * coordinates never moves. Multi-pass so a chain resolves in chain order regardless of op order.
 */
function layoutNewNodes(ir: WorkflowIR, newIds: Set<string>): void {
  const pending = ir.nodes.filter((n) => newIds.has(n.id));
  const positioned = new Set(ir.nodes.filter((n) => !newIds.has(n.id)).map((n) => n.id));
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));

  const occupied = (x: number, y: number): boolean =>
    ir.nodes.some((n) => positioned.has(n.id) && n.position.x === x && n.position.y === y);

  const place = (node: IRNode, x: number, y: number): void => {
    let slotY = y;
    while (occupied(x, slotY)) slotY += Y_PITCH;
    node.position = { x, y: slotY };
    positioned.add(node.id);
  };

  let remaining = pending;
  for (let pass = 0; pass < pending.length + 1 && remaining.length > 0; pass += 1) {
    const deferred: IRNode[] = [];
    for (const node of remaining) {
      const incoming = ir.edges.filter(
        (e) => e.target_node_id === node.id && positioned.has(e.source_node_id),
      );
      if (incoming.length > 0) {
        const anchor = incoming.reduce((a, b) => {
          const ax = byId.get(a.source_node_id)?.position.x ?? 0;
          const bx = byId.get(b.source_node_id)?.position.x ?? 0;
          return bx > ax ? b : a;
        });
        const src = byId.get(anchor.source_node_id);
        if (src) {
          place(node, src.position.x + X_PITCH, src.position.y + anchor.source_port * Y_PITCH);
          continue;
        }
      }
      const outgoing = ir.edges.find((e) => e.source_node_id === node.id && positioned.has(e.target_node_id));
      if (outgoing) {
        const target = byId.get(outgoing.target_node_id);
        if (target) {
          place(node, target.position.x - X_PITCH, target.position.y);
          continue;
        }
      }
      const hasUnplacedNeighbor = ir.edges.some(
        (e) =>
          (e.target_node_id === node.id &&
            newIds.has(e.source_node_id) &&
            !positioned.has(e.source_node_id)) ||
          (e.source_node_id === node.id && newIds.has(e.target_node_id) && !positioned.has(e.target_node_id)),
      );
      if (hasUnplacedNeighbor && pass === 0) {
        deferred.push(node); // wait for its neighbor to land first
        continue;
      }
      const rightmost = ir.nodes
        .filter((n) => positioned.has(n.id))
        .reduce((max, n) => Math.max(max, n.position.x), -Infinity);
      place(node, rightmost === -Infinity ? X0 : rightmost + X_PITCH, CENTER_Y);
    }
    remaining = deferred;
  }
}

function applyOne(ir: WorkflowIR, op: ComposeOp, ctx: ApplyContext): string {
  switch (op.op) {
    case 'add_node':
      return applyAddNode(ir, op, ctx);
    case 'update_node':
      return applyUpdateNode(ir, op, ctx.allowedTriggerTypes);
    case 'connect':
      return applyConnect(ir, op);
    case 'disconnect':
      return applyDisconnect(ir, op);
    case 'unset_parameters':
      return applyUnsetParameters(ir, op);
    case 'set_meta':
      return applySetMeta(ir, op);
    case 'remove_node':
      return applyRemoveNode(ir, op, ctx.unplaced);
    default:
      throw new ApplyOpsError(`unknown op "${String((op as { op?: unknown }).op)}" — supported: ${OP_NAMES}`);
  }
}

/** A hand-built document (or one lifted from a read projection) can arrive without coordinates. */
function isPlaced(node: IRNode): boolean {
  const position: unknown = node.position;
  return isRecord(position) && typeof position.x === 'number' && typeof position.y === 'number';
}

/** Apply a batch atomically, returning a NEW document; throws an op-indexed {@link ApplyOpsError}. */
export function applyOps(
  input: WorkflowIR | null,
  ops: ComposeOp[],
  allowedTypes: ReadonlySet<string>,
  allowedTriggerTypes: ReadonlySet<string> = new Set(),
): WorkflowIR {
  return applyOpsDetailed(input, ops, allowedTypes, allowedTriggerTypes).ir;
}

/** {@link applyOps} plus one line per op describing what it did, in op order. */
export function applyOpsDetailed(
  input: WorkflowIR | null,
  ops: ComposeOp[],
  allowedTypes: ReadonlySet<string>,
  allowedTriggerTypes: ReadonlySet<string> = new Set(),
): { ir: WorkflowIR; applied: string[] } {
  const ir = input ? cloneIr(input) : emptyIr();
  const ctx: ApplyContext = {
    allowedTypes,
    allowedTriggerTypes,
    unplaced: new Set(ir.nodes.filter((node) => !isPlaced(node)).map((node) => node.id)),
  };
  const applied = ops.map((op, i) => {
    try {
      return applyOne(ir, op, ctx);
    } catch (err) {
      if (err instanceof ApplyOpsError) throw new ApplyOpsError(`ops[${i}] ${err.message}`);
      throw err;
    }
  });
  layoutNewNodes(ir, ctx.unplaced);
  return { ir, applied };
}

/**
 * Parse one raw wire object into a ComposeOp, by hand rather than class-validator: the agent needs
 * "which field on which op", which whitelist stripping on a union DTO would bury.
 */
export function parseOp(raw: unknown, index: number): ComposeOp {
  const fail = (message: string): never => {
    throw new ApplyOpsError(`ops[${index}] ${message}`);
  };
  if (!isRecord(raw)) return fail('each op must be an object');
  const kind = raw.op;
  switch (kind) {
    case 'add_node': {
      if (!isRecord(raw.node)) return fail('add_node: missing "node" object');
      const { id, name, node_type: nodeType, parameters } = raw.node;
      if (typeof id !== 'string' || !id) return fail('add_node: node.id must be a non-empty string');
      if (typeof nodeType !== 'string' || !nodeType)
        return fail('add_node: node.node_type must be a non-empty string');
      if (name !== undefined && typeof name !== 'string') return fail('add_node: node.name must be a string');
      if (parameters !== undefined && !isRecord(parameters))
        return fail('add_node: node.parameters must be an object');
      return {
        op: 'add_node',
        node: {
          id,
          node_type: nodeType,
          ...(name !== undefined ? { name } : {}),
          ...(parameters !== undefined ? { parameters } : {}),
        },
      };
    }
    case 'update_node': {
      if (typeof raw.node_id !== 'string' || !raw.node_id)
        return fail('update_node: node_id must be a non-empty string');
      if (raw.name !== undefined && typeof raw.name !== 'string')
        return fail('update_node: name must be a string');
      if (raw.node_type !== undefined && (typeof raw.node_type !== 'string' || !raw.node_type))
        return fail('update_node: node_type must be a non-empty string (only the trigger node may set it)');
      if (raw.parameters !== undefined && !isRecord(raw.parameters))
        return fail('update_node: parameters must be an object');
      if (raw.metadata !== undefined && !isRecord(raw.metadata))
        return fail('update_node: metadata must be an object');
      return {
        op: 'update_node',
        node_id: raw.node_id,
        ...(raw.name !== undefined ? { name: raw.name } : {}),
        ...(raw.node_type !== undefined ? { node_type: raw.node_type } : {}),
        ...(raw.parameters !== undefined ? { parameters: raw.parameters } : {}),
        ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
      };
    }
    case 'connect':
      return { op: 'connect', ...parseEdgeEnds(raw, 'connect', fail) };
    case 'disconnect': {
      if (raw.target_port !== undefined && typeof raw.target_port !== 'number')
        return fail('disconnect: target_port must be a number');
      return {
        op: 'disconnect',
        ...parseEdgeEnds(raw, 'disconnect', fail),
        ...(raw.target_port !== undefined ? { target_port: raw.target_port } : {}),
      };
    }
    case 'unset_parameters': {
      if (typeof raw.node_id !== 'string' || !raw.node_id)
        return fail('unset_parameters: node_id must be a non-empty string');
      if (!Array.isArray(raw.keys) || raw.keys.length === 0)
        return fail('unset_parameters: keys must be a non-empty array of parameter names');
      const keys = raw.keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
      if (keys.length !== raw.keys.length)
        return fail('unset_parameters: every entry in keys must be a non-empty string');
      return { op: 'unset_parameters', node_id: raw.node_id, keys };
    }
    case 'set_meta': {
      if (raw.name === undefined && raw.description === undefined)
        return fail('set_meta: pass name and/or description');
      if (raw.name !== undefined && typeof raw.name !== 'string')
        return fail('set_meta: name must be a string');
      if (raw.description !== undefined && typeof raw.description !== 'string')
        return fail('set_meta: description must be a string');
      return {
        op: 'set_meta',
        ...(raw.name !== undefined ? { name: raw.name } : {}),
        ...(raw.description !== undefined ? { description: raw.description } : {}),
      };
    }
    case 'remove_node': {
      if (typeof raw.node_id !== 'string' || !raw.node_id)
        return fail('remove_node: node_id must be a non-empty string');
      return { op: 'remove_node', node_id: raw.node_id };
    }
    default:
      return fail(`unknown op "${String(kind)}" — supported: ${OP_NAMES}`);
  }
}

/** The endpoints connect and disconnect share — one parser, so the two speak the same tuple. */
function parseEdgeEnds(
  raw: Record<string, unknown>,
  op: string,
  fail: (message: string) => never,
): { source_node_id: string; target_node_id: string; source_port?: number; port_type?: ConnectPortType } {
  if (typeof raw.source_node_id !== 'string' || !raw.source_node_id)
    return fail(`${op}: source_node_id must be a non-empty string`);
  if (typeof raw.target_node_id !== 'string' || !raw.target_node_id)
    return fail(`${op}: target_node_id must be a non-empty string`);
  if (raw.source_port !== undefined && typeof raw.source_port !== 'number')
    return fail(`${op}: source_port must be a number`);
  if (raw.port_type !== undefined && !isConnectPortType(raw.port_type))
    return fail(`${op}: port_type must be one of "main", "tool", or "error"`);
  return {
    source_node_id: raw.source_node_id,
    target_node_id: raw.target_node_id,
    ...(raw.source_port !== undefined ? { source_port: raw.source_port } : {}),
    ...(raw.port_type !== undefined ? { port_type: raw.port_type } : {}),
  };
}

/** Narrow a raw wire value to the connect op's `port_type` union. */
function isConnectPortType(value: unknown): value is ConnectPortType {
  return value === 'main' || value === 'tool' || value === 'error';
}

/** "check_expense_amount" → "Check Expense Amount" — canvas titles are never raw ids. */
function prettify(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Exported for the layout unit tests. */
export const LAYOUT = { X_PITCH, Y_PITCH, X0, CENTER_Y } as const;
