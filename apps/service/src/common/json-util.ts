/** The one narrowing helper for untrusted JSON (webhook bodies, run payloads, catalog rows). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
