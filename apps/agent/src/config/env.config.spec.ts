import { validateEnv } from './env.config';

/**
 * The derivation decides whether a self-host can reach the composer at all, so
 * it is worth pinning directly: which caller-auth paths an install has, and the
 * one reason it reports when it has none.
 */

const BASE = { WORKFLOW_SERVICE_URL: 'http://localhost:8001' };

const env = (raw: Record<string, string>): ReturnType<typeof validateEnv> => validateEnv({ ...BASE, ...raw });

describe('local session auth derivation', () => {
  it('is on by default, so a self-host gets it for free', () => {
    expect(env({ SECRET_KEY: 's' }).localSessionSecret).toBe('s');
  });

  it('is off when Clerk is configured — no second front door', () => {
    expect(env({ SECRET_KEY: 's', CLERK_ISSUER: 'https://clerk.example' }).localSessionSecret).toBeNull();
  });

  it('LOCAL_AUTH_ENABLED overrides either way', () => {
    const on = env({ SECRET_KEY: 's', CLERK_ISSUER: 'https://clerk.example', LOCAL_AUTH_ENABLED: 'true' });
    expect(on.localSessionSecret).toBe('s');
    expect(env({ SECRET_KEY: 's', LOCAL_AUTH_ENABLED: 'false' }).localSessionSecret).toBeNull();
  });

  it('needs the secret, not just the flag — a missing key is not a boot failure', () => {
    expect(env({ LOCAL_AUTH_ENABLED: 'true' }).localSessionSecret).toBeNull();
  });
});

describe('composerDisabledReason', () => {
  it('names the Anthropic key first when nothing is configured', () => {
    expect(env({}).composerDisabledReason).toBe('anthropic_api_key_missing');
  });

  it('is caller_auth_unconfigured when the key is present but no caller path is', () => {
    expect(env({ ANTHROPIC_API_KEY: 'sk' }).composerDisabledReason).toBe('caller_auth_unconfigured');
  });

  it('clears once a local session secret is available — the self-host unlock', () => {
    expect(env({ ANTHROPIC_API_KEY: 'sk', SECRET_KEY: 's' }).composerDisabledReason).toBeNull();
  });

  it('clears for Clerk and for MOCK_AUTH too', () => {
    expect(
      env({ ANTHROPIC_API_KEY: 'sk', CLERK_ISSUER: 'https://c.example' }).composerDisabledReason,
    ).toBeNull();
    expect(
      env({ ANTHROPIC_API_KEY: 'sk', MOCK_AUTH: 'true', WORKFLOW_SERVICE_API_KEY: 'ork_x' })
        .composerDisabledReason,
    ).toBeNull();
  });

  it('a secret alone still reports the missing Anthropic key', () => {
    expect(env({ SECRET_KEY: 's' }).composerDisabledReason).toBe('anthropic_api_key_missing');
  });
});
