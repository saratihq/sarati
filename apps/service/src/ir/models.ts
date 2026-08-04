/**
 * WorkflowIR — the diff/merge canon. STORAGE/WIRE shapes: field names stay snake_case to remain
 * deep-equal with the JSON persisted in `workflow_versions.workflow_ir`. `port_type` is a free
 * string ('main' / 'error' / 'tool'); edges differing only by it stay distinct (constitution #12).
 */

export interface Position {
  x: number;
  y: number;
}

export interface IRNode {
  id: string;
  name: string;
  node_type: string;
  type_version: number;
  parameters: Record<string, unknown>;
  position: Position;
  credentials?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export interface IREdge {
  id: string;
  source_node_id: string;
  source_port: number;
  target_node_id: string;
  target_port: number;
  port_type: string;
}

/** The lane a step-to-step edge rides; an edge that names no lane rides this one. */
export const MAIN_PORT_TYPE = 'main';

/**
 * The lane an edge rides — decided HERE and nowhere else. A stored or hand-written edge may omit
 * `port_type`, and every reader (diff key, merge key, compiler routing) must agree it means `main`.
 */
export function edgePortType(edge: { port_type?: unknown }): string {
  return typeof edge.port_type === 'string' ? edge.port_type : MAIN_PORT_TYPE;
}

export interface WorkflowSettings {
  execution_order: string;
  extra: Record<string, unknown>;
}

export interface WorkflowIR {
  version: string;
  name: string;
  description: string;
  nodes: IRNode[];
  edges: IREdge[];
  settings: WorkflowSettings;
  metadata: Record<string, unknown>;
}

export function emptySettings(): WorkflowSettings {
  return { execution_order: 'v1', extra: {} };
}

export function nodeById(ir: WorkflowIR, nodeId: string): IRNode | undefined {
  return ir.nodes.find((n) => n.id === nodeId);
}

/** Deep structural clone via JSON (IR is plain data by construction). */
export function cloneIr<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep equality for the JSON-ish values IR carries: order-sensitive for arrays, not for object keys. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    return arrA.every((v, i) => deepEqual(v, arrB[i]));
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(recB, k) && deepEqual(recA[k], recB[k]));
}
