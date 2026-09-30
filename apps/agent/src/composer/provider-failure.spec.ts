import { providerFailureMessage } from './provider-failure';

const MODEL = 'claude-opus-4-8';
const GENERIC = providerFailureMessage(null, MODEL);

describe('providerFailureMessage', () => {
  it.each([
    ['authentication_failed', /rejected the API key.*Settings → Platform keys/],
    ['billing_error', /out of credit.*Settings → Platform keys/],
    ['rate_limit', /rate-limiting.*Wait a minute/],
    ['overloaded', /overloaded.*Wait a minute/],
    ['server_error', /server error.*Wait a minute/],
    ['model_not_found', /\(claude-opus-4-8\).*COMPOSER_MODEL/],
  ] as const)('%s says what happened and what to do about it', (error, expected) => {
    const message = providerFailureMessage(error, MODEL);
    expect(message).toMatch(expected);
    expect(message).not.toBe(GENERIC);
  });

  it.each(['unknown', 'invalid_request', 'max_output_tokens', 'oauth_org_not_allowed'] as const)(
    '%s has no remedy of its own, so it keeps the generic sentence',
    (error) => {
      expect(providerFailureMessage(error, MODEL)).toBe(GENERIC);
    },
  );

  it('never asks for a retry when retrying cannot help', () => {
    for (const error of ['authentication_failed', 'billing_error', 'model_not_found'] as const) {
      expect(providerFailureMessage(error, MODEL)).not.toMatch(/try again|send the message again/i);
    }
  });
});
