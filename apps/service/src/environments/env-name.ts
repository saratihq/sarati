/** Environment-name rules — ONE vocabulary for env rows, pointers, triggers and clusters; kept dependency-free. */

/** The production environment's name: pointer moves find production by it, and migration 008 keeps that row `is_prod` (row 7). */
export const PROD_ENV = 'production';
/** Predefined like production: locked name, undeletable. */
export const UAT_ENV = 'uat';

const LEGACY_PROD_ALIAS = 'prod';

/** Environment name shape (lowercase slugs; matched case-insensitively). */
export const ENV_NAME_SHAPE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

const RESERVED_ENV_NAMES: ReadonlyMap<string, string> = new Map([
  ['default', 'it names the connection pool'],
  [LEGACY_PROD_ALIAS, `it is another name for '${PROD_ENV}'`],
]);

function normalizeEnvName(name: string): string {
  return name.toLowerCase();
}

/** Legacy-name seam: pre-rename callers (old clients, scripts) still say 'prod'. */
export function canonicalEnvName(name: string): string {
  const normalized = normalizeEnvName(name);
  return normalized === LEGACY_PROD_ALIAS ? PROD_ENV : normalized;
}

/** The stored form of a name an environment may take, or the refusal creating or renaming one gives. */
export function admitEnvName(raw: string): { name: string } | { refusal: string } {
  const name = normalizeEnvName(raw.trim());
  if (!ENV_NAME_SHAPE.test(name)) return { refusal: 'Invalid environment name' };
  const reserved = RESERVED_ENV_NAMES.get(name);
  return reserved ? { refusal: `'${name}' is reserved — ${reserved}` } : { name };
}
