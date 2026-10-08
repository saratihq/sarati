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

/** Whether a run is within reach: an org's run only through that org; an org-less run follows its workflow, or is its owner's. */
export function reachesRun(access: RunAccess, run: { orgId: string | null; hasWorkflow: boolean }): boolean {
  if (run.orgId !== null) return access.orgIds.includes(run.orgId);
  return run.hasWorkflow ? !access.pinned : true;
}

/** {@link reachesRun} as SQL over `runtime_runs r LEFT JOIN workflows w`, for the given `$n` positions. */
export function runReachSql(orgIdsParam: number, pinnedParam: number): string {
  const org = 'COALESCE(r.org_id, w.org_id)';
  return `(CASE WHEN ${org} IS NOT NULL THEN ${org} = ANY($${orgIdsParam}::uuid[]) WHEN r.workflow_id IS NOT NULL THEN NOT $${pinnedParam}::boolean ELSE true END)`;
}
