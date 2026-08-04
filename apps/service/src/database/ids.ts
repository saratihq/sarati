/** App-side uuid4 — the DB has no default for these ids. */
export function newId(): string {
  return crypto.randomUUID();
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
  return /^[0-9a-f-]{36}$/i.test(value);
}
