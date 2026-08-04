import type { OrgRole } from '../database/entities/organization.entity';
import type { UserEntity } from '../database/entities/user.entity';

/** The authenticated caller; `activeOrgId` is the request's tenancy context (guard-validated X-Org-Id → personal org). */
type PrincipalBase = {
  user: UserEntity;
  activeOrgId: string | null;
  activeOrgRole: OrgRole | null;
};

/** A signed-in human — full authority. */
export type UserPrincipal = PrincipalBase & { kind: 'user' };

/** A bearer credential (CI, script, MCP agent): same identity as its owner, less authority. `scopes: null` = legacy key. */
export type ApiKeyPrincipal = PrincipalBase & {
  kind: 'api_key';
  scopes: string[] | null;
  keyOrgId: string | null;
};

export type Principal = UserPrincipal | ApiKeyPrincipal;

/** The scopes to hold this principal to; a session is not scope-limited, so it holds them all. */
export function principalScopes(principal: Principal): string[] | null {
  return principal.kind === 'api_key' ? principal.scopes : null;
}

export const REQUEST_PRINCIPAL = Symbol('REQUEST_PRINCIPAL');

export function principalOf(req: unknown): Principal | undefined {
  return (req as Record<symbol, Principal | undefined>)[REQUEST_PRINCIPAL];
}

/** The principal on a guarded request. Absence means the route escaped `AuthGuard` — a wiring bug, not a 401. */
export function requirePrincipal(req: unknown): Principal {
  const principal = principalOf(req);
  if (!principal) throw new Error('principal missing after guard');
  return principal;
}

export function attachPrincipal(req: unknown, principal: Principal): void {
  (req as Record<symbol, Principal>)[REQUEST_PRINCIPAL] = principal;
}
