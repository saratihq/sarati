import { parseWebhookPath, webhookPathFor, webhookUrlFor } from './webhook-url';

const WF = '11111111-1111-1111-1111-111111111111';

describe('webhookPathFor / webhookUrlFor (ADR 0018 per-(workflow,env) URL)', () => {
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
