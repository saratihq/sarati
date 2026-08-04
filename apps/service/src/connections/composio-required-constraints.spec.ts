import { composioToolFor } from '../providers/sdk-actions.registry';
import { requiredConstraintsFor, requiredConstraintTypes } from './composio-required-constraints';

/**
 * The curated one-of table plus a CONSISTENCY guard: every constrained type is a real catalog action and every
 * one-of member an ACTUAL argument name on that tool, so the executor's pre-flight reads a key that can exist.
 */
describe('composio-required-constraints', () => {
  it('declares the confirmed one-of offenders and nothing else', () => {
    expect([...requiredConstraintTypes()].sort()).toEqual([
      'asana.get_team_memberships',
      'calendly.list_organization_memberships',
    ]);
  });

  it('asana.get_team_memberships requires one of team/workspace/user', () => {
    const groups = requiredConstraintsFor('asana.get_team_memberships');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.oneOf).toEqual(['team', 'workspace', 'user']);
  });

  it('calendly.list_organization_memberships requires one of organization/user', () => {
    const groups = requiredConstraintsFor('calendly.list_organization_memberships');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.oneOf).toEqual(['organization', 'user']);
  });

  it('returns an empty list for an unconstrained type', () => {
    expect(requiredConstraintsFor('gmail.send_email')).toEqual([]);
    expect(requiredConstraintsFor('nope.not_real')).toEqual([]);
  });

  it('deliberately omits excel.list_files (the schema defaults drive_id/path — no bare 400)', () => {
    expect(requiredConstraintTypes().has('excel.list_files')).toBe(false);
  });

  // CONSISTENCY: every constraint must reference a real catalog tool whose args
  // actually include every one-of member — a typo or a stale param name is a bug.
  it('every constrained type + one-of member exists on the real catalog tool', () => {
    for (const type of requiredConstraintTypes()) {
      const tool = composioToolFor(type);
      expect(tool).toBeDefined();
      const args = new Set(tool!.inputProperties);
      for (const group of requiredConstraintsFor(type)) {
        for (const member of group.oneOf) {
          expect(args.has(member)).toBe(true);
        }
      }
    }
  });
});
