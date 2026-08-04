import {
  cloneIr,
  deepEqual,
  edgePortType,
  emptySettings,
  type IREdge,
  type IRNode,
  type Position,
  type WorkflowIR,
  type WorkflowSettings,
} from './models';

/**
 * Structural diff between two WorkflowIRs. Ordering is deterministic (node ids sorted, edge keys
 * sorted tuple-wise, dict paths sorted). Rename detection is PRESENTATIONAL ONLY — it must never
 * feed applyDiff/merge, where a collapsed rename would silently no-op against the ancestor.
 * It reads both documents through the dump normalizers below, because it must answer for whatever
 * is IN the database: throwing on a stored document breaks the diff view AND invariant #3, whose
 * no-diff check would then fall through and mint a version.
 */

export const IRDiffOperation = {
  ADD_NODE: 'add_node',
  REMOVE_NODE: 'remove_node',
  MODIFY_NODE: 'modify_node',
  RENAME_NODE: 'rename_node',
  ADD_EDGE: 'add_edge',
  REMOVE_EDGE: 'remove_edge',
  MODIFY_SETTINGS: 'modify_settings',
} as const;
export type IRDiffOperationType = (typeof IRDiffOperation)[keyof typeof IRDiffOperation];

export interface IRDiffEntry {
  operation: IRDiffOperationType;
  target_id: string;
  target_name: string | null;
  path: string | null;
  old_value: unknown;
  new_value: unknown;
}

export interface RenamePair {
  old_name: string;
  new_name: string;
}

export interface IRDiff {
  entries: IRDiffEntry[];
  summary: string;
  renames: RenamePair[];
}

function entry(partial: Partial<IRDiffEntry> & Pick<IRDiffEntry, 'operation' | 'target_id'>): IRDiffEntry {
  return {
    target_name: null,
    path: null,
    old_value: null,
    new_value: null,
    ...partial,
  };
}

/** Stable tuple key for matching edges across versions — edge identity is the endpoints, not the id. */
/** The endpoint fields an edge is identified by; ports and lane default the way the engine reads them. */
export interface EdgeEndpoints {
  source_node_id: string;
  source_port?: number;
  target_node_id: string;
  target_port?: number;
  port_type?: string;
}

/** Edge identity is the endpoint TUPLE, never the `id` label (invariant #13) — defined here alone. */
export function edgeKey(edge: EdgeEndpoints): [string, number, string, number, string] {
  return [
    edge.source_node_id,
    edge.source_port ?? 0,
    edge.target_node_id,
    edge.target_port ?? 0,
    edgePortType(edge),
  ];
}

/** Two edges are the same edge when their endpoint tuples match. */
export function sameEdgeEndpoints(a: EdgeEndpoints, b: EdgeEndpoints): boolean {
  const [as, ap, at, atp, ax] = edgeKey(a);
  const [bs, bp, bt, btp, bx] = edgeKey(b);
  return as === bs && ap === bp && at === bt && atp === btp && ax === bx;
}

function compareEdgeKeys(a: ReturnType<typeof edgeKey>, b: ReturnType<typeof edgeKey>): number {
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av) < String(bv) ? -1 : 1;
  }
  return 0;
}

/** Deep dict diff to dotted paths, keys sorted. */
function diffDicts(
  oldRec: Record<string, unknown>,
  newRec: Record<string, unknown>,
  prefix: string,
): Array<[string, unknown, unknown]> {
  const changes: Array<[string, unknown, unknown]> = [];
  const allKeys = [...new Set([...Object.keys(oldRec), ...Object.keys(newRec)])].sort();

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = key in oldRec ? oldRec[key] : null;
    const newVal = key in newRec ? newRec[key] : null;
    if (deepEqual(oldVal, newVal)) continue;
    if (isPlainRecord(oldVal) && isPlainRecord(newVal)) {
      changes.push(...diffDicts(oldVal, newVal, path));
    } else {
      changes.push([path, oldVal, newVal]);
    }
  }
  return changes;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A node's canvas coordinates; a stored node that carries none sits at the origin. */
function positionOf(source: { position?: unknown }): Position {
  const pos = isPlainRecord(source.position) ? source.position : {};
  return { x: numOr0(pos.x), y: numOr0(pos.y) };
}

/** Full node payload as a plain record — the shape carried in add/remove diff entries. */
export function nodeDump(node: IRNode): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    node_type: node.node_type,
    type_version: node.type_version,
    parameters: isPlainRecord(node.parameters) ? node.parameters : {},
    position: positionOf(node),
    credentials: node.credentials ?? null,
    metadata: isPlainRecord(node.metadata) ? node.metadata : {},
  };
}

function edgeDump(edge: IREdge): Record<string, unknown> {
  return {
    id: edge.id,
    source_node_id: edge.source_node_id,
    source_port: edge.source_port,
    target_node_id: edge.target_node_id,
    target_port: edge.target_port,
    port_type: edge.port_type,
  };
}

/** High-precision add+remove pairing — presentation only, never fed to applyDiff/merge. */
function detectRenamePairs(entries: IRDiffEntry[]): { entries: IRDiffEntry[]; renames: RenamePair[] } {
  const adds = entries.filter((e) => e.operation === IRDiffOperation.ADD_NODE);
  const removes = entries.filter((e) => e.operation === IRDiffOperation.REMOVE_NODE);
  if (adds.length === 0 || removes.length === 0) return { entries, renames: [] };

  const removesByType = new Map<unknown, IRDiffEntry[]>();
  for (const rem of removes) {
    if (!isPlainRecord(rem.old_value)) continue;
    const type = rem.old_value.node_type;
    const bucket = removesByType.get(type) ?? [];
    bucket.push(rem);
    removesByType.set(type, bucket);
  }

  const matched: Array<[IRDiffEntry, IRDiffEntry]> = [];
  const usedRemoveIds = new Set<string>();

  for (const add of adds) {
    if (!isPlainRecord(add.new_value)) continue;
    const newPos = isPlainRecord(add.new_value.position) ? add.new_value.position : {};
    const newParams = isPlainRecord(add.new_value.parameters) ? add.new_value.parameters : {};

    for (const rem of removesByType.get(add.new_value.node_type) ?? []) {
      if (usedRemoveIds.has(rem.target_id)) continue;
      const oldValue = isPlainRecord(rem.old_value) ? rem.old_value : {};
      const oldPos = isPlainRecord(oldValue.position) ? oldValue.position : {};
      const oldParams = isPlainRecord(oldValue.parameters) ? oldValue.parameters : {};
      const samePosition =
        Math.abs(numOr0(newPos.x) - numOr0(oldPos.x)) < 5 &&
        Math.abs(numOr0(newPos.y) - numOr0(oldPos.y)) < 5;
      // `{} == {}` must NOT count as a rename signal.
      const sameParams = Object.keys(newParams).length > 0 && deepEqual(oldParams, newParams);
      if (samePosition || sameParams) {
        matched.push([add, rem]);
        usedRemoveIds.add(rem.target_id);
        break;
      }
    }
  }

  if (matched.length === 0) return { entries, renames: [] };

  const matchedAddIds = new Set(matched.map(([a]) => a.target_id));
  const matchedRemoveIds = new Set(matched.map(([, r]) => r.target_id));
  const surviving = entries.filter(
    (e) =>
      !(e.operation === IRDiffOperation.ADD_NODE && matchedAddIds.has(e.target_id)) &&
      !(e.operation === IRDiffOperation.REMOVE_NODE && matchedRemoveIds.has(e.target_id)),
  );

  const renames: RenamePair[] = [];
  for (const [add, rem] of matched) {
    const newValue = isPlainRecord(add.new_value) ? add.new_value : {};
    const oldValue = isPlainRecord(rem.old_value) ? rem.old_value : {};
    const oldName = typeof oldValue.name === 'string' ? oldValue.name : '';
    const newName = typeof newValue.name === 'string' ? newValue.name : '';
    renames.push({ old_name: oldName, new_name: newName });

    surviving.push(
      entry({
        operation: IRDiffOperation.RENAME_NODE,
        target_id: add.target_id,
        target_name: newName,
        path: 'name',
        old_value: oldName,
        new_value: newName,
      }),
    );

    const oldParams = isPlainRecord(oldValue.parameters) ? oldValue.parameters : {};
    const newParams = isPlainRecord(newValue.parameters) ? newValue.parameters : {};
    if (!deepEqual(oldParams, newParams)) {
      for (const [path, ov, nv] of diffDicts(oldParams, newParams, 'parameters')) {
        surviving.push(
          entry({
            operation: IRDiffOperation.MODIFY_NODE,
            target_id: add.target_id,
            target_name: newName,
            path,
            old_value: ov,
            new_value: nv,
          }),
        );
      }
    }

    const oldPos = isPlainRecord(oldValue.position) ? oldValue.position : {};
    const newPos = isPlainRecord(newValue.position) ? newValue.position : {};
    if (!deepEqual(oldPos, newPos)) {
      surviving.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: add.target_id,
          target_name: newName,
          path: 'position',
          old_value: oldPos,
          new_value: newPos,
        }),
      );
    }
  }

  return { entries: surviving, renames };
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Every node of a stored document, normalized and keyed by id; a non-object entry is not a node. */
function normalizedNodes(ir: WorkflowIR): Map<string, IRNode> {
  const nodes = new Map<string, IRNode>();
  for (const raw of Array.isArray(ir.nodes) ? ir.nodes : []) {
    if (isPlainRecord(raw)) {
      const node = irNodeFromDump(raw);
      nodes.set(node.id, node);
    }
  }
  return nodes;
}

/** Every edge of a stored document, normalized (so an absent lane is `main`, decided once). */
function normalizedEdges(ir: WorkflowIR): IREdge[] {
  const edges: IREdge[] = [];
  for (const raw of Array.isArray(ir.edges) ? ir.edges : []) {
    if (isPlainRecord(raw)) edges.push(irEdgeFromDump(raw));
  }
  return edges;
}

/** A stored document's settings; an absent block is the default one, never a crash. */
function normalizedSettings(ir: WorkflowIR): WorkflowSettings {
  const raw: Record<string, unknown> = isPlainRecord(ir.settings) ? ir.settings : {};
  const fallback = emptySettings();
  return {
    execution_order: typeof raw.execution_order === 'string' ? raw.execution_order : fallback.execution_order,
    extra: isPlainRecord(raw.extra) ? raw.extra : fallback.extra,
  };
}

export function computeDiff(
  oldIr: WorkflowIR,
  newIr: WorkflowIR,
  options: { detectRenames?: boolean } = {},
): IRDiff {
  const entries: IRDiffEntry[] = [];

  const oldNodes = normalizedNodes(oldIr);
  const newNodes = normalizedNodes(newIr);

  for (const nid of [...newNodes.keys()].filter((id) => !oldNodes.has(id)).sort()) {
    const node = newNodes.get(nid)!;
    entries.push(
      entry({
        operation: IRDiffOperation.ADD_NODE,
        target_id: nid,
        target_name: node.name,
        new_value: nodeDump(node),
      }),
    );
  }

  for (const nid of [...oldNodes.keys()].filter((id) => !newNodes.has(id)).sort()) {
    const node = oldNodes.get(nid)!;
    entries.push(
      entry({
        operation: IRDiffOperation.REMOVE_NODE,
        target_id: nid,
        target_name: node.name,
        old_value: nodeDump(node),
      }),
    );
  }

  for (const nid of [...oldNodes.keys()].filter((id) => newNodes.has(id)).sort()) {
    const oldNode = oldNodes.get(nid)!;
    const newNode = newNodes.get(nid)!;

    if (oldNode.name !== newNode.name) {
      entries.push(
        entry({
          operation: IRDiffOperation.RENAME_NODE,
          target_id: nid,
          target_name: newNode.name,
          path: 'name',
          old_value: oldNode.name,
          new_value: newNode.name,
        }),
      );
    }

    for (const [path, oldVal, newVal] of diffDicts(oldNode.parameters, newNode.parameters, 'parameters')) {
      entries.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: nid,
          target_name: newNode.name,
          path,
          old_value: oldVal,
          new_value: newVal,
        }),
      );
    }

    const oldCreds = oldNode.credentials ?? {};
    const newCreds = newNode.credentials ?? {};
    if (!deepEqual(oldCreds, newCreds)) {
      entries.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: nid,
          target_name: newNode.name,
          path: 'credentials',
          old_value: oldCreds,
          new_value: newCreds,
        }),
      );
    }

    if (
      !deepEqual(
        { x: oldNode.position.x, y: oldNode.position.y },
        { x: newNode.position.x, y: newNode.position.y },
      )
    ) {
      entries.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: nid,
          target_name: newNode.name,
          path: 'position',
          old_value: { x: oldNode.position.x, y: oldNode.position.y },
          new_value: { x: newNode.position.x, y: newNode.position.y },
        }),
      );
    }

    if (oldNode.node_type !== newNode.node_type) {
      entries.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: nid,
          target_name: newNode.name,
          path: 'node_type',
          old_value: oldNode.node_type,
          new_value: newNode.node_type,
        }),
      );
    }
    if (oldNode.type_version !== newNode.type_version) {
      entries.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: nid,
          target_name: newNode.name,
          path: 'type_version',
          old_value: oldNode.type_version,
          new_value: newNode.type_version,
        }),
      );
    }

    for (const [path, oldVal, newVal] of diffDicts(oldNode.metadata, newNode.metadata, 'metadata')) {
      entries.push(
        entry({
          operation: IRDiffOperation.MODIFY_NODE,
          target_id: nid,
          target_name: newNode.name,
          path,
          old_value: oldVal,
          new_value: newVal,
        }),
      );
    }
  }

  const oldEdges = new Map(normalizedEdges(oldIr).map((e) => [JSON.stringify(edgeKey(e)), e]));
  const newEdges = new Map(normalizedEdges(newIr).map((e) => [JSON.stringify(edgeKey(e)), e]));

  const addedKeys = [...newEdges.entries()]
    .filter(([k]) => !oldEdges.has(k))
    .sort((a, b) => compareEdgeKeys(edgeKey(a[1]), edgeKey(b[1])));
  for (const [, edge] of addedKeys) {
    entries.push(
      entry({ operation: IRDiffOperation.ADD_EDGE, target_id: edge.id, new_value: edgeDump(edge) }),
    );
  }

  const removedKeys = [...oldEdges.entries()]
    .filter(([k]) => !newEdges.has(k))
    .sort((a, b) => compareEdgeKeys(edgeKey(a[1]), edgeKey(b[1])));
  for (const [, edge] of removedKeys) {
    entries.push(
      entry({ operation: IRDiffOperation.REMOVE_EDGE, target_id: edge.id, old_value: edgeDump(edge) }),
    );
  }

  const oldSettings = normalizedSettings(oldIr);
  const newSettings = normalizedSettings(newIr);
  for (const [path, oldVal, newVal] of diffDicts({ ...oldSettings }, { ...newSettings }, 'settings')) {
    entries.push(
      entry({
        operation: IRDiffOperation.MODIFY_SETTINGS,
        target_id: 'settings',
        path,
        old_value: oldVal,
        new_value: newVal,
      }),
    );
  }

  let finalEntries = entries;
  let renames: RenamePair[] = [];
  if (options.detectRenames) {
    const result = detectRenamePairs(entries);
    finalEntries = result.entries;
    renames = result.renames;
  }

  const adds = finalEntries.filter((e) => e.operation === IRDiffOperation.ADD_NODE).length;
  const removes = finalEntries.filter((e) => e.operation === IRDiffOperation.REMOVE_NODE).length;
  const modifies = finalEntries.filter(
    (e) => e.operation === IRDiffOperation.MODIFY_NODE || e.operation === IRDiffOperation.RENAME_NODE,
  ).length;
  const edgeChanges = finalEntries.filter(
    (e) => e.operation === IRDiffOperation.ADD_EDGE || e.operation === IRDiffOperation.REMOVE_EDGE,
  ).length;

  const parts: string[] = [];
  if (adds) parts.push(`${adds} node(s) added`);
  if (removes) parts.push(`${removes} node(s) removed`);
  if (modifies) parts.push(`${modifies} node modification(s)`);
  if (edgeChanges) parts.push(`${edgeChanges} connection change(s)`);
  const summary = parts.length ? parts.join('; ') : 'No changes';

  return { entries: finalEntries, summary, renames };
}

/** Apply diff entries to a base IR; a node removal cascades to its edges. */
export function applyDiff(base: WorkflowIR, diff: IRDiff): WorkflowIR {
  const result = cloneIr(base);
  const nodesById = new Map(result.nodes.map((n) => [n.id, n]));

  for (const e of diff.entries) {
    switch (e.operation) {
      case IRDiffOperation.ADD_NODE: {
        if (!isPlainRecord(e.new_value)) break;
        const node = irNodeFromDump(e.new_value);
        result.nodes.push(node);
        nodesById.set(node.id, node);
        break;
      }
      case IRDiffOperation.REMOVE_NODE: {
        result.nodes = result.nodes.filter((n) => n.id !== e.target_id);
        nodesById.delete(e.target_id);
        result.edges = result.edges.filter(
          (edge) => edge.source_node_id !== e.target_id && edge.target_node_id !== e.target_id,
        );
        break;
      }
      case IRDiffOperation.RENAME_NODE: {
        const node = nodesById.get(e.target_id);
        if (node && e.new_value !== null && e.new_value !== undefined)
          node.name = typeof e.new_value === 'string' ? e.new_value : JSON.stringify(e.new_value);
        break;
      }
      case IRDiffOperation.MODIFY_NODE: {
        const node = nodesById.get(e.target_id);
        if (node && e.path) setNested(node as unknown as Record<string, unknown>, e.path, e.new_value);
        break;
      }
      case IRDiffOperation.ADD_EDGE: {
        if (!isPlainRecord(e.new_value)) break;
        result.edges.push(irEdgeFromDump(e.new_value));
        break;
      }
      case IRDiffOperation.REMOVE_EDGE: {
        // Remove by the endpoint TUPLE, not the `id` label: a `main` and an `error` edge between
        // the same nodes share an id, so filtering by id would collapse both (constitution #12/#13).
        if (isPlainRecord(e.old_value)) {
          const removedKey = JSON.stringify(edgeKey(irEdgeFromDump(e.old_value)));
          result.edges = result.edges.filter((edge) => JSON.stringify(edgeKey(edge)) !== removedKey);
        } else {
          // Legacy entry with no edge dump — fall back to the id label.
          result.edges = result.edges.filter((edge) => edge.id !== e.target_id);
        }
        break;
      }
      case IRDiffOperation.MODIFY_SETTINGS: {
        if (!e.path) break;
        const path = e.path.startsWith('settings.') ? e.path.slice('settings.'.length) : e.path;
        setNested(result.settings as unknown as Record<string, unknown>, path, e.new_value);
        break;
      }
    }
  }
  return result;
}

/** Set a value at a dotted path, creating records on the way; bails on a non-traversable segment. */
export function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (isPlainRecord(next)) {
      current = next;
    } else if (next === undefined || next === null) {
      const created: Record<string, unknown> = {};
      current[part] = created;
      current = created;
    } else {
      return; // non-traversable segment
    }
  }
  current[parts[parts.length - 1]!] = value;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
}

export function irNodeFromDump(dump: Record<string, unknown>): IRNode {
  return {
    id: strOf(dump.id),
    name: strOf(dump.name),
    node_type: strOf(dump.node_type),
    type_version: typeof dump.type_version === 'number' ? dump.type_version : 1,
    parameters: isPlainRecord(dump.parameters) ? dump.parameters : {},
    position: positionOf(dump),
    credentials: isPlainRecord(dump.credentials) ? dump.credentials : null,
    metadata: isPlainRecord(dump.metadata) ? dump.metadata : {},
  };
}

/** Normalizes a stored edge; the lane rule itself lives on `edgePortType` (models.ts). */
export function irEdgeFromDump(dump: Record<string, unknown>): IREdge {
  return {
    id: strOf(dump.id),
    source_node_id: strOf(dump.source_node_id),
    source_port: typeof dump.source_port === 'number' ? dump.source_port : 0,
    target_node_id: strOf(dump.target_node_id),
    target_port: typeof dump.target_port === 'number' ? dump.target_port : 0,
    port_type: edgePortType(dump),
  };
}
