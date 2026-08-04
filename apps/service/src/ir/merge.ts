import { DomainError } from '../common/domain-error';
import {
  applyDiff,
  computeDiff,
  irNodeFromDump,
  nodeDump,
  setNested,
  type IRDiff,
  type IRDiffEntry,
} from './diff';
import { cloneIr, deepEqual, nodeById, type IREdge, type IRNode, type WorkflowIR } from './models';

/**
 * Three-way merge with field-level-within-node conflicts keyed on `(target_id, path)`, plus an
 * `edit_delete` kind (edited one side, removed the other) so a delete never silently wins.
 * Without resolutions, conflicts block the merge; with them, every conflict must be resolved.
 * Rename detection stays OFF here (presentational only); picking the common ancestor is the caller's job.
 */

export type ConflictKind = 'field' | 'edit_delete';

export interface ConflictEntry {
  node_id: string;
  node_name: string;
  /** `field` = same node+field changed both sides; `edit_delete` = edited one side, removed the other. */
  kind: ConflictKind;
  /** null for `edit_delete` (the whole node is in play, not one field). */
  field_path: string | null;
  /** Only present for `edit_delete`: which side removed the node. */
  deleted_on?: 'source' | 'target';
  source_value: unknown;
  target_value: unknown;
  ancestor_value: unknown;
}

export type ResolutionChoice = 'source' | 'target' | 'custom' | 'keep' | 'delete';

export interface MergeResolution {
  node_id: string;
  /** Match key: the conflict's field_path (null for edit_delete). */
  field_path: string | null;
  choice: ResolutionChoice;
  /** Required for the `custom` choice — the operator-authored field value. */
  value?: unknown;
}

export interface MergeResult {
  success: boolean;
  merged: WorkflowIR | null;
  conflicts: ConflictEntry[];
  source_diff: IRDiff | null;
  target_diff: IRDiff | null;
}

const REMOVE_NODE = 'remove_node';
const MODIFY_NODE = 'modify_node';
const RENAME_NODE = 'rename_node';
const ADD_EDGE = 'add_edge';
const REMOVE_EDGE = 'remove_edge';

const NODE_OPS = new Set<string>([REMOVE_NODE, MODIFY_NODE, RENAME_NODE, 'add_node']);
const FIELD_CHOICES = new Set<ResolutionChoice>(['source', 'target', 'custom']);
const EDIT_DELETE_CHOICES = new Set<ResolutionChoice>(['keep', 'delete']);

const isEdgeOp = (op: string): boolean => op === ADD_EDGE || op === REMOVE_EDGE;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merge-layer identity key. Edges key on their endpoint TUPLE incl. port_type, never the `id` label
 * (which a main and an error edge share, so id-keying would drop one) — constitution #12/#13.
 */
const keyOf = (e: IRDiffEntry): string => {
  if (isEdgeOp(e.operation)) {
    const d = e.new_value ?? e.old_value;
    if (isRecord(d)) {
      return JSON.stringify([
        'edge',
        d.source_node_id,
        d.source_port,
        d.target_node_id,
        d.target_port,
        d.port_type,
      ]);
    }
  }
  return JSON.stringify([e.target_id, e.path]);
};
const resolutionKey = (nodeId: string, fieldPath: string | null): string =>
  JSON.stringify([nodeId, fieldPath]);

export function threeWayMerge(
  ancestor: WorkflowIR,
  source: WorkflowIR,
  target: WorkflowIR,
  resolutions?: MergeResolution[],
): MergeResult {
  // Rename detection must stay OFF on merge paths (presentational only).
  const sourceDiff = computeDiff(ancestor, source);
  const targetDiff = computeDiff(ancestor, target);

  const sourceChanges = new Map<string, IRDiffEntry>();
  for (const e of sourceDiff.entries) sourceChanges.set(keyOf(e), e);
  const targetChanges = new Map<string, IRDiffEntry>();
  for (const e of targetDiff.entries) targetChanges.set(keyOf(e), e);

  // ── field-level conflicts (same (node_id, path) changed differently) ──
  const conflicts: ConflictEntry[] = [];
  const conflictedFieldKeys = new Set<string>();
  // add/add nodes are WHOLE-NODE conflicts, excluded from the auto-apply so neither side's
  // node is silently kept — the resolver rebuilds it from the chosen side.
  const wholeNodeConflictIds = new Set<string>();
  for (const [key, sEntry] of sourceChanges) {
    const tEntry = targetChanges.get(key);
    if (!tEntry) continue;
    // A matching key IS the same edge, so the same edge added/removed on both sides is
    // never a conflict — it combines in the clean/base build.
    if (isEdgeOp(sEntry.operation) && isEdgeOp(tEntry.operation)) continue;
    if (deepEqual(sEntry.new_value, tEntry.new_value) && sEntry.operation === tEntry.operation) continue;
    if (sEntry.operation === REMOVE_NODE && tEntry.operation === REMOVE_NODE) continue;

    // add/add: the WHOLE node differs, so there is no single field to pick —
    // `field_path` is null and the resolver picks a whole side.
    if (sEntry.operation === 'add_node' && tEntry.operation === 'add_node') {
      wholeNodeConflictIds.add(sEntry.target_id);
      conflicts.push({
        node_id: sEntry.target_id,
        node_name: sEntry.target_name ?? tEntry.target_name ?? '',
        kind: 'field',
        field_path: null,
        source_value: sEntry.new_value,
        target_value: tEntry.new_value,
        ancestor_value: null, // not in the ancestor
      });
      continue;
    }

    conflictedFieldKeys.add(key);
    conflicts.push({
      node_id: sEntry.target_id,
      node_name: sEntry.target_name ?? tEntry.target_name ?? '',
      kind: 'field',
      field_path: sEntry.path ?? null,
      source_value: sEntry.new_value,
      target_value: tEntry.new_value,
      ancestor_value: sEntry.old_value,
    });
  }

  // ── edit_delete conflicts (modified one side, removed the other) ──
  // Removed on BOTH sides is NOT a conflict — it stays clean.
  const removedOnSource = nodeIdsWithOp(sourceDiff, REMOVE_NODE);
  const removedOnTarget = nodeIdsWithOp(targetDiff, REMOVE_NODE);
  const modifiedOnSource = nodeIdsModified(sourceDiff);
  const modifiedOnTarget = nodeIdsModified(targetDiff);
  const editDeleteNodeIds = new Set<string>();

  for (const nodeId of removedOnSource) {
    if (removedOnTarget.has(nodeId)) continue; // both delete → clean
    if (!modifiedOnTarget.has(nodeId)) continue;
    editDeleteNodeIds.add(nodeId);
    conflicts.push(editDeleteConflict(nodeId, 'source', ancestor, source, target));
  }
  for (const nodeId of removedOnTarget) {
    if (removedOnSource.has(nodeId)) continue;
    if (!modifiedOnSource.has(nodeId)) continue;
    editDeleteNodeIds.add(nodeId);
    conflicts.push(editDeleteConflict(nodeId, 'target', ancestor, source, target));
  }

  // ── no conflicts: the clean-merge build (target diff, then non-overlapping source) ──
  if (conflicts.length === 0) {
    const nonOverlappingSource: IRDiff = {
      entries: sourceDiff.entries.filter((e) => !targetChanges.has(keyOf(e))),
      summary: sourceDiff.summary,
      renames: [],
    };
    let merged = applyDiff(ancestor, targetDiff);
    merged = applyDiff(merged, nonOverlappingSource);
    return { success: true, merged, conflicts: [], source_diff: sourceDiff, target_diff: targetDiff };
  }

  // ── conflicts, no resolutions: block ──
  if (!resolutions || resolutions.length === 0) {
    return { success: false, merged: null, conflicts, source_diff: sourceDiff, target_diff: targetDiff };
  }

  // ── resolutions supplied: match each conflict, validate, then build ──
  const byKey = new Map<string, MergeResolution>();
  for (const r of resolutions) byKey.set(resolutionKey(r.node_id, r.field_path ?? null), r);

  const unresolved: ConflictEntry[] = [];
  const applied: Array<{ conflict: ConflictEntry; resolution: MergeResolution }> = [];
  for (const c of conflicts) {
    const r = byKey.get(resolutionKey(c.node_id, c.field_path));
    if (!r) {
      unresolved.push(c);
      continue;
    }
    assertLegalChoice(c, r);
    applied.push({ conflict: c, resolution: r });
  }
  if (unresolved.length > 0) {
    return {
      success: false,
      merged: null,
      conflicts: unresolved,
      source_diff: sourceDiff,
      target_diff: targetDiff,
    };
  }

  // Base = ancestor + targetDiff + non-overlapping sourceDiff, EXCLUDING every conflicted field
  // key and every entry touching a conflicted node, so no side lands silently.
  const excluded = (e: IRDiffEntry): boolean => {
    if (entryTouchesNode(e, editDeleteNodeIds)) return true;
    if (entryTouchesNode(e, wholeNodeConflictIds)) return true;
    if (e.path != null && conflictedFieldKeys.has(keyOf(e))) return true;
    return false;
  };
  const targetBaseDiff: IRDiff = {
    entries: targetDiff.entries.filter((e) => !excluded(e)),
    summary: targetDiff.summary,
    renames: [],
  };
  const sourceBaseDiff: IRDiff = {
    entries: sourceDiff.entries.filter((e) => !targetChanges.has(keyOf(e)) && !excluded(e)),
    summary: sourceDiff.summary,
    renames: [],
  };
  let base = applyDiff(ancestor, targetBaseDiff);
  base = applyDiff(base, sourceBaseDiff);

  // Apply the resolved choices on top of the base.
  for (const { conflict, resolution } of applied) {
    if (conflict.kind === 'edit_delete') {
      applyEditDeleteResolution(base, conflict, resolution, source, target);
    } else if (conflict.field_path == null) {
      applyWholeNodeResolution(base, conflict, resolution, source, target);
    } else {
      applyFieldResolution(base, conflict, resolution);
    }
  }

  return { success: true, merged: base, conflicts: [], source_diff: sourceDiff, target_diff: targetDiff };
}

function nodeIdsWithOp(diff: IRDiff, op: string): Set<string> {
  return new Set(diff.entries.filter((e) => e.operation === op).map((e) => e.target_id));
}

function nodeIdsModified(diff: IRDiff): Set<string> {
  return new Set(
    diff.entries
      .filter((e) => e.operation === MODIFY_NODE || e.operation === RENAME_NODE)
      .map((e) => e.target_id),
  );
}

function editDeleteConflict(
  nodeId: string,
  deletedOn: 'source' | 'target',
  ancestor: WorkflowIR,
  source: WorkflowIR,
  target: WorkflowIR,
): ConflictEntry {
  const ancestorNode = nodeById(ancestor, nodeId);
  const editingNode = deletedOn === 'source' ? nodeById(target, nodeId) : nodeById(source, nodeId);
  const editedDump = editingNode ? nodeDump(editingNode) : null;
  return {
    node_id: nodeId,
    node_name: editingNode?.name ?? ancestorNode?.name ?? '',
    kind: 'edit_delete',
    field_path: null,
    deleted_on: deletedOn,
    // The deleting side is null; the editing side carries the node dump.
    source_value: deletedOn === 'source' ? null : editedDump,
    target_value: deletedOn === 'target' ? null : editedDump,
    ancestor_value: ancestorNode ? nodeDump(ancestorNode) : null,
  };
}

/** A diff entry "touches" a node when it is a node op on it, or an edge with it as an endpoint. */
function entryTouchesNode(e: IRDiffEntry, nodeIds: Set<string>): boolean {
  if (NODE_OPS.has(e.operation)) return nodeIds.has(e.target_id);
  if (e.operation === ADD_EDGE || e.operation === REMOVE_EDGE) {
    const dump = (e.new_value ?? e.old_value) as Record<string, unknown> | null;
    if (dump && typeof dump === 'object') {
      const s = dump.source_node_id;
      const t = dump.target_node_id;
      return (typeof s === 'string' && nodeIds.has(s)) || (typeof t === 'string' && nodeIds.has(t));
    }
  }
  return false;
}

function assertLegalChoice(conflict: ConflictEntry, resolution: MergeResolution): void {
  const legal = conflict.kind === 'field' ? FIELD_CHOICES : EDIT_DELETE_CHOICES;
  if (!legal.has(resolution.choice)) {
    const allowed = [...legal].join(' | ');
    throw new DomainError(
      `Illegal resolution choice '${resolution.choice}' for ${conflict.kind} conflict on node ` +
        `'${conflict.node_id}'${conflict.field_path ? ` (${conflict.field_path})` : ''} — expected one of: ${allowed}`,
    );
  }
}

function applyFieldResolution(base: WorkflowIR, conflict: ConflictEntry, resolution: MergeResolution): void {
  const node = nodeById(base, conflict.node_id);
  if (!node || !conflict.field_path) return;
  const value =
    resolution.choice === 'source'
      ? conflict.source_value
      : resolution.choice === 'target'
        ? conflict.target_value
        : resolution.value;
  setNested(node as unknown as Record<string, unknown>, conflict.field_path, value);
}

/**
 * Resolve an add/add WHOLE-NODE conflict: the base carries neither version, so rebuild the node AND
 * its incident edges from the chosen side (or an operator-authored dump) — never lose the wiring.
 */
function applyWholeNodeResolution(
  base: WorkflowIR,
  conflict: ConflictEntry,
  resolution: MergeResolution,
  source: WorkflowIR,
  target: WorkflowIR,
): void {
  const nodeId = conflict.node_id;
  // Strip any partial remnant (defensive — the base build excluded it already).
  base.nodes = base.nodes.filter((n) => n.id !== nodeId);
  base.edges = base.edges.filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId);

  if (resolution.choice === 'custom') {
    if (isRecord(resolution.value)) base.nodes.push(irNodeFromDump(resolution.value));
    return;
  }
  const chosenIr = resolution.choice === 'source' ? source : target;
  const chosenNode = nodeById(chosenIr, nodeId);
  if (chosenNode) base.nodes.push(cloneIr<IRNode>(chosenNode));
  const incident = chosenIr.edges.filter((e) => e.source_node_id === nodeId || e.target_node_id === nodeId);
  for (const edge of incident) base.edges.push(cloneIr<IREdge>(edge));
}

function applyEditDeleteResolution(
  base: WorkflowIR,
  conflict: ConflictEntry,
  resolution: MergeResolution,
  source: WorkflowIR,
  target: WorkflowIR,
): void {
  const nodeId = conflict.node_id;
  // The base carries the ANCESTOR node + its edges (every change to this node was excluded), so
  // strip both, then either restore from the editing side (`keep`) or leave it gone (`delete`).
  base.nodes = base.nodes.filter((n) => n.id !== nodeId);
  base.edges = base.edges.filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId);
  if (resolution.choice === 'delete') return;

  const editingIr = conflict.deleted_on === 'source' ? target : source;
  const editedNode = nodeById(editingIr, nodeId);
  if (editedNode) base.nodes.push(cloneIr<IRNode>(editedNode));
  const incident = editingIr.edges.filter((e) => e.source_node_id === nodeId || e.target_node_id === nodeId);
  for (const edge of incident) base.edges.push(cloneIr<IREdge>(edge));
}
