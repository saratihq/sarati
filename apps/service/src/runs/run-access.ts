import { reachesOrg, type Principal } from '../auth/principal';
import type { PolicyService } from '../policy/policy.service';

/** How far a caller may reach into run history: always their own runs, org-wide only for an interactive session. */
export interface RunAccess {
  /** The runs' owner id (`runtime_runs.user_id`). */
  userId: string;
  /** The request's tenancy context; null = personal scope. */
  activeOrgId: string | null;
  /** Whether the caller inherits the org-wide approvals reach over other members' runs. */
  orgWide: boolean;
  /** Orgs whose workflows' runs the caller may reach at all: current memberships, narrowed to a key's pin. */
  orgIds: string[];
  /** A key pinned to one org reaches no run of a workflow outside it, not even an org-less one. */
  pinned: boolean;
}

/**
 * The one place principal kind becomes run reach: a bearer credential (CI, script, MCP agent) sees only
 * its own runs, because org-wide visibility exists for the human approvals inbox and consults no policy.
 */
export async function runAccessOf(principal: Principal, policy: PolicyService): Promise<RunAccess> {
  return {
    userId: principal.user.id,
    activeOrgId: principal.activeOrgId,
    orgWide: principal.kind !== 'api_key',
    orgIds: await policy.reachableOrgIds(principal),
    pinned: !reachesOrg(principal, null),
  };
}

/** Whether a run of a workflow in this org is within reach; `undefined` = the run has no workflow at all. */
export function reachesRunWorkflow(access: RunAccess, workflowOrgId: string | null | undefined): boolean {
  if (workflowOrgId === undefined) return true;
  if (workflowOrgId === null) return !access.pinned;
  return access.orgIds.includes(workflowOrgId);
}

/** {@link reachesRunWorkflow} as SQL over `runtime_runs r LEFT JOIN workflows w`, for the given `$n` positions. */
export function runReachSql(orgIdsParam: number, pinnedParam: number): string {
  return `(r.workflow_id IS NULL OR w.org_id = ANY($${orgIdsParam}::uuid[]) OR (w.org_id IS NULL AND NOT $${pinnedParam}::boolean))`;
}
