/** API-key capability scopes. Sessions are not scope-limited; keys are. */
export const API_SCOPES = [
  'workflow:read',
  'workflow:write',
  'workflow:deploy',
  // Previewing and firing for real are different capabilities: a dry run changes nothing outside
  // , so a key can be trusted to preview without ever being able to fire.
  'run:dry',
  'run:execute',
  // Calling a PUBLISHED workflow as a tool. Deliberately separate: a key holding only
  // this can invoke your live automations and read nothing about how they are built.
  'workflow:invoke',
  'connection:read',
  'connection:write',
  'org:manage',
  'key:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const ALL = new Set<string>(API_SCOPES);

/** Never grantable: a key that mints keys can mint an unscoped one. */
export const NON_GRANTABLE_SCOPE: ApiScope = 'key:manage';

export const GRANTABLE_SCOPES: readonly ApiScope[] = API_SCOPES.filter((s) => s !== NON_GRANTABLE_SCOPE);

export function isApiScope(value: string): value is ApiScope {
  return ALL.has(value);
}

/** `held === null` is a legacy key: full authority, minus the escalation scope. */
export function scopeSatisfied(held: readonly string[] | null, required: ApiScope): boolean {
  if (required === NON_GRANTABLE_SCOPE) return false;
  if (held === null) return true;
  return held.includes(required);
}
