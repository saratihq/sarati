/** Environment-name rules — ONE vocabulary for env rows, pointers, triggers and clusters; kept dependency-free. */

/** The production environment; resolution anchors on `is_prod`, never on this string alone. */
export const PROD_ENV = 'production';
/** Predefined like production: locked name, undeletable. */
export const UAT_ENV = 'uat';

/** Environment name shape (lowercase slugs; matched case-insensitively). */
export const ENV_NAME_SHAPE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

/** Reserved: 'default' labels the per-user connection pool (ADR 0014), 'prod' is the legacy production alias. */
export const RESERVED_ENV_NAMES = new Set(['default', 'prod']);

/** Env names are case-insensitive slugs — stored and compared lowercase. */
export function normalizeEnvName(name: string): string {
  return name.toLowerCase();
}

/** Legacy-name seam: pre-rename callers (old clients, scripts) still say 'prod'. */
export function canonicalEnvName(name: string): string {
  const normalized = normalizeEnvName(name);
  return normalized === 'prod' ? PROD_ENV : normalized;
}
