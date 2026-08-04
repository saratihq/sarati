import type { Principal } from '../auth/principal';

/** How far a caller may reach into run history: always their own runs, org-wide only for an interactive session. */
export interface RunAccess {
  /** The runs' owner id (`runtime_runs.user_id`). */
  userId: string;
  /** The request's tenancy context; null = personal scope. */
  activeOrgId: string | null;
  /** Whether the caller inherits the org-wide approvals reach over other members' runs. */
  orgWide: boolean;
}

/**
 * The one place principal kind becomes run reach: a bearer credential (CI, script, MCP agent) sees only
 * its own runs, because org-wide visibility exists for the human approvals inbox and consults no policy.
 */
export function runAccessOf(principal: Principal): RunAccess {
  return {
    userId: principal.user.id,
    activeOrgId: principal.activeOrgId,
    orgWide: principal.kind !== 'api_key',
  };
}
