import type { WorkflowIR } from '../ir/models';
import { threeWayMerge, type ConflictEntry, type MergeResolution } from '../ir/merge';

/**
 * The composer's live-reconciliation merge: the SAME field-level three-way core the review flow
 * uses, wrapped for the co-editing loop (`base` = canvas at turn start, `ours` = the user's live
 * canvas, `theirs` = the agent's draft). It ALWAYS returns a document — conflicts resolve
 * OURS-WINS so the user's edit is never silently lost, and are reported so the agent can ask.
 */

export interface ComposerConflict {
  node_id: string;
  node_name: string;
  kind: 'field' | 'edit_delete';
  field_path: string | null;
  /** The user's value (what the merged document currently holds). */
  ours: unknown;
  /** The agent's value (offer it as the alternative). */
  theirs: unknown;
  base: unknown;
}

export interface ComposerMergeResult {
  merged: WorkflowIR;
  conflicts: ComposerConflict[];
}

const POSITION_PATH = 'position';

export function composerMerge(base: WorkflowIR, ours: WorkflowIR, theirs: WorkflowIR): ComposerMergeResult {
  // source = the agent's lineage, target = the user's. Resolution choice
  // 'target' therefore means "the user's value wins".
  const first = threeWayMerge(base, theirs, ours);
  if (first.success && first.merged) {
    return { merged: first.merged, conflicts: [] };
  }

  const resolutions: MergeResolution[] = first.conflicts.map((c) => ({
    node_id: c.node_id,
    field_path: c.field_path,
    // Field collisions: the user's value stays. Edit-vs-delete: keep the node
    // (whichever side edited it wins over the delete — no silent data loss).
    choice: c.kind === 'field' ? 'target' : 'keep',
  }));
  const resolved = threeWayMerge(base, theirs, ours, resolutions);
  if (!resolved.success || !resolved.merged) {
    // Unreachable by construction, but a merge that still fails must be loud rather
    // than a silently dropped canvas.
    throw new Error('composer merge could not auto-resolve — this is a bug in the resolution mapping');
  }

  return {
    merged: resolved.merged,
    conflicts: first.conflicts.filter(isRealConflict).map(toComposerConflict),
  };
}

/** User-dragged positions always win and are never worth a question. */
function isRealConflict(c: ConflictEntry): boolean {
  return !(c.kind === 'field' && c.field_path === POSITION_PATH);
}

function toComposerConflict(c: ConflictEntry): ComposerConflict {
  return {
    node_id: c.node_id,
    node_name: c.node_name,
    kind: c.kind,
    field_path: c.field_path,
    ours: c.target_value,
    theirs: c.source_value,
    base: c.ancestor_value,
  };
}
