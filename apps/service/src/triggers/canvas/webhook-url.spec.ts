import { parseWebhookPath, sameWebhookIntake, webhookPathFor, webhookUrlFor } from './webhook-url';

const WF = '11111111-1111-1111-1111-111111111111';

describe('webhookPathFor / webhookUrlFor (per-(workflow,env) URL)', () => {
  it('builds the canonical two-segment path and canonicalizes the env (prod → production)', () => {
    expect(webhookPathFor(WF, 'staging')).toBe(`/api/hooks/${WF}/staging`);
    expect(webhookPathFor(WF, 'prod')).toBe(`/api/hooks/${WF}/production`);
  });

  it('joins onto a base URL and trims a trailing slash on the base', () => {
    expect(webhookUrlFor('https://app.example.com/', WF, 'production')).toBe(
      `https://app.example.com/api/hooks/${WF}/production`,
    );
  });
});

describe('parseWebhookPath (route disambiguation)', () => {
  it('parses a valid per-(workflow,env) path, canonicalizing the env', () => {
    expect(parseWebhookPath(`/api/hooks/${WF}/prod`)).toEqual({ workflowId: WF, environment: 'production' });
    expect(parseWebhookPath(`api/hooks/${WF}/staging/`)).toEqual({ workflowId: WF, environment: 'staging' });
  });

  it('returns null for the legacy single-segment /:triggerId route', () => {
    expect(parseWebhookPath(`/api/hooks/${WF}`)).toBeNull();
  });

  it('returns null for the catch test-intake route (literal "catch" ≠ a uuid)', () => {
    expect(parseWebhookPath(`/api/hooks/catch/${WF}`)).toBeNull();
  });

  it('returns null for a non-uuid workflow segment or extra segments', () => {
    expect(parseWebhookPath('/api/hooks/not-a-uuid/prod')).toBeNull();
    expect(parseWebhookPath(`/api/hooks/${WF}/prod/extra`)).toBeNull();
    expect(parseWebhookPath('/api/other/x/y')).toBeNull();
  });
});

describe('sameWebhookIntake (what the intake routes by)', () => {
  it('reaches one intake from any host, scheme or prefix in front of the same hooks path', () => {
    const served = `https://automation.acme.com/api/hooks/${WF}/production`;
    expect(sameWebhookIntake(`http://sarati.acme.com/api/hooks/${WF}/production`, served)).toBe(true);
    expect(sameWebhookIntake(`https://acme.com/sarati/api/hooks/${WF}/prod`, served)).toBe(true);
    expect(sameWebhookIntake(null, null)).toBe(true);
  });

  it('reaches another intake for another environment or workflow, and none from a URL that is not one', () => {
    const served = `https://acme.com/api/hooks/${WF}/production`;
    expect(sameWebhookIntake(`https://acme.com/api/hooks/${WF}/staging`, served)).toBe(false);
    expect(
      sameWebhookIntake(`https://acme.com/api/hooks/22222222-2222-2222-2222-222222222222/production`, served),
    ).toBe(false);
    expect(sameWebhookIntake(`https://acme.com/api/other/${WF}/production`, served)).toBe(false);
    expect(sameWebhookIntake(null, served)).toBe(false);
  });
});
