import { toolNameOf } from './workflow-tool-contract';

describe('workflow tool names', () => {
  it('turns a declared name into something an agent can call', () => {
    expect(toolNameOf('refund_customer', 'Refund')).toBe('refund_customer');
    expect(toolNameOf('Refund a customer', 'x')).toBe('refund_a_customer');
  });

  it('falls back to the workflow name when none is declared', () => {
    expect(toolNameOf(undefined, 'Onboard Employee')).toBe('onboard_employee');
    expect(toolNameOf('   ', 'Onboard Employee')).toBe('onboard_employee');
  });

  /** A workflow must never be able to shadow a platform tool, nor be quietly renamed into safety. */
  it('refuses a reserved name outright', () => {
    expect(toolNameOf('orchestr_commit', 'x')).toBeNull();
    expect(toolNameOf('orchestr_', 'x')).toBeNull();
    expect(toolNameOf('Orchestrate Refunds', 'x')).toBeNull();
  });

  it('refuses a name a client could not use', () => {
    expect(toolNameOf('!!!', '???')).toBeNull();
    expect(toolNameOf('2fast', 'x')).toBeNull();
  });

  it('bounds the length rather than emitting an unusable name', () => {
    expect(toolNameOf('a'.repeat(200), 'x')).toHaveLength(60);
  });
});
