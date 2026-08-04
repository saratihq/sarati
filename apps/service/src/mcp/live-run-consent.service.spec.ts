import type { DomainError } from '../common/domain-error';
import { LIVE_RUNS_PER_HOUR, LiveRunConsentService } from './live-run-consent.service';

const doc = (text: string): Record<string, unknown> => ({
  nodes: [{ id: 'say', parameters: { texts: [text] } }],
});

const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (err) {
    return String((err as DomainError).details?.code);
  }
  return 'no-error';
};

describe('live-run consent', () => {
  let consent: LiveRunConsentService;

  beforeEach(() => {
    consent = new LiveRunConsentService();
  });

  it('lets a caller fire the exact document it just previewed', () => {
    const token = consent.issue('u1', doc('hello'));
    expect(() => consent.consume('u1', token, doc('hello'))).not.toThrow();
  });

  it('refuses a live run with no confirmation at all', () => {
    expect(codeOf(() => consent.consume('u1', undefined, doc('hello')))).toBe('confirmation_required');
  });

  /** Otherwise an agent previews something harmless and fires something else. */
  it('refuses a token issued for a DIFFERENT document', () => {
    const token = consent.issue('u1', doc('harmless'));
    expect(codeOf(() => consent.consume('u1', token, doc('dangerous')))).toBe('confirmation_mismatch');
  });

  it('is single-use — a token cannot fire twice', () => {
    const token = consent.issue('u1', doc('hello'));
    consent.consume('u1', token, doc('hello'));
    expect(codeOf(() => consent.consume('u1', token, doc('hello')))).toBe('confirmation_expired');
  });

  it("is per credential — another key cannot spend this one's token", () => {
    const token = consent.issue('u1', doc('hello'));
    expect(codeOf(() => consent.consume('u2', token, doc('hello')))).toBe('confirmation_expired');
  });

  it('caps live runs per credential per hour, and says so', () => {
    for (let i = 0; i < LIVE_RUNS_PER_HOUR; i++) consent.chargeLiveRun('u1');
    expect(codeOf(() => consent.chargeLiveRun('u1'))).toBe('live_run_budget_exhausted');
    // The budget is per credential, not global.
    expect(() => consent.chargeLiveRun('u2')).not.toThrow();
  });
});
