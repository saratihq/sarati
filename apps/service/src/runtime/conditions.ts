import { resolveReference, type UnresolvedRefSink } from './reference-resolver';

/**
 * Conditions for `if` routers. Structured (not an eval'd
 * expression string) so they're safe and serializable. Both operands may be
 * `{{ref}}` strings resolved against the run scope, or literals.
 */
export type CompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'truthy' | 'falsy';

export interface Condition {
  /** Left operand: a literal, or a `{{ref}}` string resolved against scope. */
  left: unknown;
  op: CompareOp;
  /** Right operand (resolved like `left`); unused for `truthy`/`falsy`. */
  right?: unknown;
}

/** A router: an `if` with one condition, or a `switch` with cases in order. */
export type Router =
  { kind: 'if'; condition: Condition } | { kind: 'switch'; cases: ReadonlyArray<{ condition: Condition }> };

/** The port `router` takes over `scope`: an `if` 0 when its condition holds, else 1; a `switch` its first case that holds, else its default. */
export function routedPort(
  router: Router,
  scope: Record<string, unknown>,
  onUnresolved?: UnresolvedRefSink,
): number {
  if (router.kind === 'if') return evaluateCondition(router.condition, scope, onUnresolved) ? 0 : 1;
  const matched = router.cases.findIndex((c) => evaluateCondition(c.condition, scope, onUnresolved));
  return matched === -1 ? router.cases.length : matched;
}

export function evaluateCondition(
  condition: Condition,
  scope: Record<string, unknown>,
  onUnresolved?: UnresolvedRefSink,
): boolean {
  // `truthy`/`falsy` ARE the test for absence, so a missing value there is the answer, not a problem.
  const sink = condition.op === 'truthy' || condition.op === 'falsy' ? undefined : onUnresolved;
  const left = resolveReference(condition.left, scope, sink);
  if (condition.op === 'truthy') return isTruthy(left);
  if (condition.op === 'falsy') return !isTruthy(left);

  const right = resolveReference(condition.right, scope, sink);
  switch (condition.op) {
    case 'eq':
      return valuesEqual(left, right);
    case 'ne':
      return !valuesEqual(left, right);
    case 'gt':
      return toNumber(left) > toNumber(right);
    case 'gte':
      return toNumber(left) >= toNumber(right);
    case 'lt':
      return toNumber(left) < toNumber(right);
    case 'lte':
      return toNumber(left) <= toNumber(right);
    case 'contains':
      return contains(left, right);
    default:
      return false;
  }
}

/** Workflow-author-friendly truthiness: empty string/array/object count as false. */
function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint') return Number(v);
  return NaN;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function contains(left: unknown, right: unknown): boolean {
  if (typeof left === 'string') {
    const needle =
      typeof right === 'string'
        ? right
        : typeof right === 'number' || typeof right === 'boolean' || typeof right === 'bigint'
          ? String(right)
          : '';
    return needle.length > 0 && left.includes(needle);
  }
  if (Array.isArray(left)) return left.some((el) => valuesEqual(el, right));
  return false;
}
