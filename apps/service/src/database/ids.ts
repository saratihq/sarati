import { createHash } from 'node:crypto';

// Persisted: every id `nameBasedId` minted is derived from it, so changing it re-mints them all.
const NAME_BASED_ID_NAMESPACE = Buffer.from('5f0e8a3c9b2d4e61a7c41d2b8e6f9a30', 'hex');

/** App-side uuid4 — the DB has no default for these ids. */
export function newId(): string {
  return crypto.randomUUID();
}

/** A uuid5 of `parts`: the same parts always name the same id. */
export function nameBasedId(...parts: string[]): string {
  const hash = createHash('sha1').update(NAME_BASED_ID_NAMESPACE).update(JSON.stringify(parts)).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** App-side UTC now — the DB has no default for these timestamps. */
export function now(): Date {
  return new Date();
}

/**
 * Whether a caller-supplied string is SHAPED like one of our ids. The ONE such check: a value that
 * fails it must never reach a `uuid` column, where Postgres would raise a 500 instead of a 404.
 */
export function isIdShape(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
