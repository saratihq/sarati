import { type Principal, principalScopes } from '../auth/principal';
import { scopeSatisfied } from '../auth/scopes';

/** Reading a run is `workflow:read`; a key holding only `workflow:invoke` or `run:dry` has no way to. */
export function mayReadRuns(principal: Principal): boolean {
  return scopeSatisfied(principalScopes(principal), 'workflow:read');
}

/** Said in place of a poll pointer to a credential that may start a run but not read one. */
export const CANNOT_POLL_NOTE =
  'Still running. This credential cannot read runs — reading one takes the "workflow:read" scope.';
