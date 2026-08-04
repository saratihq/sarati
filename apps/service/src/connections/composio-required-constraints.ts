/**
 * Curated one-of constraints for Composio actions whose schema UNDER-declares what a bare call needs — JSON-Schema
 * `required` can't express "one OR the other", so those tools report `required: []` and 400 at the provider.
 * Keys are the FINAL argument names, so the pre-flight validator reads them straight off the built arguments.
 * DISCIPLINE: an entry earns its place only when the live schema confirms a bare call genuinely fails.
 */

/** One conditional-required group: at least ONE `oneOf` member must be present. */
export interface RequiredGroup {
  /** Human phrase for the 400 message (e.g. `"organization or user"`). */
  label: string;
  /** Final-arg names; the group is satisfied when ANY one is present (non-nullish). */
  oneOf: string[];
}

const CONSTRAINTS = new Map<string, RequiredGroup[]>([
  [
    'asana.get_team_memberships',
    [{ label: 'team, workspace, or user', oneOf: ['team', 'workspace', 'user'] }],
  ],
  [
    'calendly.list_organization_memberships',
    [{ label: 'organization or user', oneOf: ['organization', 'user'] }],
  ],
]);

/** The groups for a public `<app>.<action>` type — AND across groups, OR within one; empty for most types. */
export function requiredConstraintsFor(publicType: string): readonly RequiredGroup[] {
  return CONSTRAINTS.get(publicType) ?? [];
}

/** Every constrained type — the consistency spec's input. */
export function requiredConstraintTypes(): ReadonlySet<string> {
  return new Set(CONSTRAINTS.keys());
}
