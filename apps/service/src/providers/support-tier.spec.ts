import { deriveSupport, type SupportFacts, supportFacts } from './support-tier';

/** Support-tier derivation + precedence, driven off the REAL committed sources so a drift breaks the test, not the badge. */
describe('support-tier', () => {
  const facts = (managed: string[]): SupportFacts => ({
    managed: new Set(managed),
  });

  describe('deriveSupport', () => {
    it('auth:none → instant, regardless of app facts (utility apps are never "limited")', () => {
      const s = deriveSupport({ type: 'http.send_request', auth: 'none' }, facts([]));
      expect(s).toEqual({ tier: 'instant', reason: 'No account needed' });
    });

    it('control nodes (orchestr:if) → instant', () => {
      const s = deriveSupport({ type: 'orchestr:if', auth: 'none' }, facts([]));
      expect(s.tier).toBe('instant');
    });

    it('managed app → instant (one-click managed connect)', () => {
      const s = deriveSupport({ type: 'gmail.send_email', auth: 'connection' }, facts(['gmail']));
      expect(s.tier).toBe('instant');
      expect(s.reason).toMatch(/managed/i);
    });

    it('connection app without a managed broker → needs_setup', () => {
      const s = deriveSupport({ type: 'smtp.send_email', auth: 'connection' }, facts([]));
      expect(s.tier).toBe('needs_setup');
      expect(s.reason).toMatch(/OAuth app or API key/);
    });

    it('a trigger-less managed app is NOT limited — "limited" is action-level only (review 2026-07-13)', () => {
      const s = deriveSupport({ type: 'slack.send_message', auth: 'connection' }, facts(['slack']));
      expect(s.tier).toBe('instant');
    });

    it('an UNSUPPORTED override marker → limited, outranking everything (real table)', () => {
      // docs.append_text is a real `null` marker in composio-direct-overrides.
      const s = deriveSupport({ type: 'docs.append_text', auth: 'connection' }, facts(['docs']));
      expect(s).toEqual({ tier: 'limited', reason: 'Not available on managed connections yet' });
    });

    it('a mapped (non-null) override stays on the app-level tier', () => {
      const s = deriveSupport({ type: 'gmail.send_email', auth: 'connection' }, facts(['gmail']));
      expect(s.tier).toBe('instant');
    });
  });

  describe('supportFacts', () => {
    it('managed set mirrors the committed Composio catalog (gmail in, smtp/imap out)', () => {
      const { managed } = supportFacts();
      expect(managed.has('gmail')).toBe(true);
      expect(managed.has('sheets')).toBe(true);
      expect(managed.has('smtp')).toBe(false);
      expect(managed.has('imap')).toBe(false);
      expect(managed.size).toBeGreaterThan(50); // the managed-auth toolkit family, not a stub
    });
  });
});
