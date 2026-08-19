import { deepEqual } from '../ir/models';
import type { RunOutputChange, RunOutputRegression } from './review-test.types';

/**
 * Field-level regression between two runs' output maps — a RUN-OUTPUT diff, NOT the IR
 * `computeDiff` that compares workflow docs. `before`=base (baseline), `after`=head (the change).
 */

/** Max field changes recorded — beyond this the diff is truncated (the run rows keep the full output). */
const MAX_CHANGES = 200;
/** Max characters of a changed leaf value kept in the summary. */
const VALUE_PREVIEW_CHARS = 512;

export function diffRunOutputs(
  base: Record<string, unknown>,
  head: Record<string, unknown>,
): RunOutputRegression {
  const baseKeys = Object.keys(base);
  const headKeys = new Set(Object.keys(head));
  const baseSet = new Set(baseKeys);
  const added = [...headKeys].filter((k) => !baseSet.has(k)).sort();
  const removed = baseKeys.filter((k) => !headKeys.has(k)).sort();

  const changed: RunOutputChange[] = [];
  for (const nodeId of baseKeys.filter((k) => headKeys.has(k)).sort()) {
    if (changed.length >= MAX_CHANGES) break;
    scan(base[nodeId], head[nodeId], '', (path, before, after, count) => {
      if (changed.length < MAX_CHANGES) {
        changed.push({
          node_id: nodeId,
          path: path || '(value)',
          before: preview(before),
          after: preview(after),
          ...(count === undefined ? {} : { count }),
        });
      }
    });
  }
  return { changed, added, removed };
}

type Emit = (path: string, before: unknown, after: unknown, count?: number) => void;

/** Walk two JSON values in parallel, emitting a change at each differing leaf/shape boundary. */
function scan(before: unknown, after: unknown, path: string, emit: Emit): void {
  if (deepEqual(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      scan(before[key], after[key], path ? `${path}.${key}` : key, emit);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    scanArrays(before, after, path, emit);
    return;
  }
  // Differing primitives, or a type/shape change (object↔array↔scalar) — one change.
  emit(path, before, after);
}

/**
 * Overlapping indices diff element by element; the tail one side does not have is ONE row carrying
 * its size, because N dropped entries are a length change, not N independent findings.
 */
function scanArrays(before: unknown[], after: unknown[], path: string, emit: Emit): void {
  const common = Math.min(before.length, after.length);
  for (let i = 0; i < common; i++) scan(before[i], after[i], `${path}[${i}]`, emit);
  const longer = Math.max(before.length, after.length);
  const size = longer - common;
  if (size === 0) return;
  if (size === 1) {
    scan(before[common], after[common], `${path}[${common}]`, emit);
    return;
  }
  const range = `${path}[${common}…${longer - 1}]`;
  const removed = before.length > after.length;
  emit(range, removed ? before.slice(common) : null, removed ? null : after.slice(common), size);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Cap a leaf value's stored size so the review summary stays small. */
function preview(value: unknown): unknown {
  if (typeof value === 'string' && value.length > VALUE_PREVIEW_CHARS) {
    return `${value.slice(0, VALUE_PREVIEW_CHARS)}… (${value.length} chars)`;
  }
  if (value !== null && typeof value === 'object') {
    const json = JSON.stringify(value);
    if (json && json.length > VALUE_PREVIEW_CHARS)
      return `${json.slice(0, VALUE_PREVIEW_CHARS)}… (truncated)`;
  }
  return value;
}
