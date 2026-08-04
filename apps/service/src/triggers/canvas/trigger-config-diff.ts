import { computeDiff } from '../../ir/diff';
import type { WorkflowIR } from '../../ir/models';

/**
 * Did the trigger node change between the old and new pointed versions? Answered by `computeDiff` —
 * the vault's SINGLE "did content change" authority (invariant #4) — never a `JSON.stringify`.
 * A coarse upper bound (a canvas-position nudge also flags); the reconciler narrows it.
 */
export function triggerConfigChangedAcrossVersions(
  oldIr: WorkflowIR,
  newIr: WorkflowIR,
  triggerNodeId: string,
): boolean {
  return computeDiff(oldIr, newIr).entries.some((e) => e.target_id === triggerNodeId);
}
