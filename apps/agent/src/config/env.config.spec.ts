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

describe('callerAuthConfigured', () => {
  it('is false when no caller path is configured', () => {
    expect(env({}).callerAuthConfigured).toBe(false);
  });

  it('a local session secret is the self-host unlock', () => {
    expect(env({ SECRET_KEY: 's' }).callerAuthConfigured).toBe(true);
  });

  it('Clerk and MOCK_AUTH count too', () => {
    expect(env({ CLERK_ISSUER: 'https://c.example' }).callerAuthConfigured).toBe(true);
    expect(env({ MOCK_AUTH: 'true', WORKFLOW_SERVICE_API_KEY: 'ork_x' }).callerAuthConfigured).toBe(true);
  });

  it('does not depend on an Anthropic key — that is set at runtime, not at boot', () => {
    expect(env({ SECRET_KEY: 's', ANTHROPIC_API_KEY: 'sk' }).callerAuthConfigured).toBe(true);
  });
});

describe('serviceSharedSecret', () => {
  it('holds SECRET_KEY even where local sessions are off — it also authenticates the key read', () => {
    const cfg = env({ SECRET_KEY: 's', LOCAL_AUTH_ENABLED: 'false' });
    expect(cfg.localSessionSecret).toBeNull();
    expect(cfg.serviceSharedSecret).toBe('s');
  });

  it('is null when the stack shares no secret', () => {
    expect(env({}).serviceSharedSecret).toBeNull();
  });
});
