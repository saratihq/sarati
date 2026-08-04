/**
 * Resolve `{{stepId.path.to.field}}` references against the outputs of already-run steps. A string
 * that is EXACTLY one reference resolves to the value with its TYPE PRESERVED; an embedded
 * reference interpolates as a string. Paths are dot-separated and numeric segments index arrays.
 * An unknown step id fails fast (a mis-wired plan is a bug, not a blank); a path running off the
 * end resolves to `undefined`, mirroring property access.
 */

import { isFileHandle } from './blob-store';

const FULL_REF = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
const EMBEDDED_REF = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Optional honesty sink, called only for a FULL-STRING `{{ref}}` resolving to `undefined` — never
 * for an embedded ref (where `''` can be intentional), a reserved `$`-ref, or a real `null`.
 */
export type UnresolvedRefSink = (ref: string) => void;

export function resolveReferences(
  props: Record<string, unknown>,
  outputs: Record<string, unknown>,
  onUnresolved?: UnresolvedRefSink,
): Record<string, unknown> {
  return resolveReference(props, outputs, onUnresolved) as Record<string, unknown>;
}

/** Resolve a single value (type preserved); strings/arrays/objects recurse, anything else passes through. */
export function resolveReference(
  value: unknown,
  outputs: Record<string, unknown>,
  onUnresolved?: UnresolvedRefSink,
): unknown {
  if (typeof value === 'string') return resolveString(value, outputs, onUnresolved);
  if (Array.isArray(value)) return value.map((v) => resolveReference(v, outputs, onUnresolved));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveReference(v, outputs, onUnresolved);
    return out;
  }
  return value;
}

// `$`-prefixed refs are RESERVED and left untouched: the provider fills `$auth` later, so the
// secret never lands in the scope or a checkpoint.
const isReserved = (ref: string): boolean => ref.trim().startsWith('$');

function resolveString(
  str: string,
  outputs: Record<string, unknown>,
  onUnresolved?: UnresolvedRefSink,
): unknown {
  const full = FULL_REF.exec(str);
  if (full) {
    const ref = full[1] ?? '';
    if (isReserved(ref)) return str;
    const value = lookup(ref, outputs); // whole string is one ref → keep the value's type
    // `null` is a real value, not a miss.
    if (value === undefined) onUnresolved?.(ref);
    return value;
  }
  return str.replace(EMBEDDED_REF, (match, ref: string) =>
    isReserved(ref) ? match : interpolate(lookup(ref, outputs)),
  );
}

function lookup(ref: string, outputs: Record<string, unknown>): unknown {
  const segments = ref
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const [stepId, ...path] = segments;
  if (stepId === undefined) throw new Error(`Empty reference "{{${ref}}}"`);
  if (!Object.prototype.hasOwnProperty.call(outputs, stepId)) {
    throw new Error(`Reference {{${ref}}} points at unknown step "${stepId}"`);
  }

  let current: unknown = outputs[stepId];
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function interpolate(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  // A file is bytes, not text — embedding it would stringify the handle to noise and lose the file.
  if (isFileHandle(value)) {
    throw new Error('a file cannot be embedded in a string — reference it directly, e.g. {{step.file}}');
  }
  // Objects/arrays serialize to JSON; symbols/functions fall through to ''.
  return JSON.stringify(value) ?? '';
}
