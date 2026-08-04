import { DomainError } from '../common/domain-error';
import {
  assertSafeOAuthEndpoint,
  type ByoOAuthClient,
  byoClientToConfig,
  loadOAuthProviders,
  OAuthProvidersService,
  parseByoClient,
} from './oauth-providers';

const REDIRECT = 'http://localhost:8001/api/connections/oauth/callback';

describe('loadOAuthProviders', () => {
  it('configures a catalog provider from just client id/secret', () => {
    const reg = loadOAuthProviders(
      { OAUTH_GOOGLE_CLIENT_ID: 'gid', OAUTH_GOOGLE_CLIENT_SECRET: 'gsecret' },
      REDIRECT,
    );
    const google = reg.get('google');
    expect(google).toBeDefined();
    expect(google?.authUrl).toContain('accounts.google.com');
    expect(google?.tokenUrl).toContain('oauth2.googleapis.com');
    expect(google?.clientId).toBe('gid');
    expect(google?.redirectUri).toBe(REDIRECT);
    expect(google?.usePkce).toBe(true);
    expect(google?.authExtraParams).toEqual({ access_type: 'offline', prompt: 'consent' });
  });

  it('skips a provider missing its secret', () => {
    const reg = loadOAuthProviders({ OAUTH_GOOGLE_CLIENT_ID: 'gid' }, REDIRECT);
    expect(reg.get('google')).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it('supports a fully custom provider via env-declared endpoints', () => {
    const reg = loadOAuthProviders(
      {
        OAUTH_ACME_CLIENT_ID: 'aid',
        OAUTH_ACME_CLIENT_SECRET: 'asecret',
        OAUTH_ACME_AUTH_URL: 'https://acme.test/authorize',
        OAUTH_ACME_TOKEN_URL: 'https://acme.test/token',
        OAUTH_ACME_SCOPES: 'read write',
      },
      REDIRECT,
    );
    const acme = reg.get('acme');
    expect(acme?.authUrl).toBe('https://acme.test/authorize');
    expect(acme?.tokenUrl).toBe('https://acme.test/token');
    expect(acme?.scopes).toEqual(['read', 'write']);
  });

  it('skips a custom provider that has no endpoints (not in the catalog)', () => {
    const reg = loadOAuthProviders({ OAUTH_ACME_CLIENT_ID: 'aid', OAUTH_ACME_CLIENT_SECRET: 's' }, REDIRECT);
    expect(reg.get('acme')).toBeUndefined();
  });

  it('lets env override catalog endpoints/scopes (how tests point at a fake server)', () => {
    const reg = loadOAuthProviders(
      {
        OAUTH_GOOGLE_CLIENT_ID: 'gid',
        OAUTH_GOOGLE_CLIENT_SECRET: 'gsecret',
        OAUTH_GOOGLE_AUTH_URL: 'http://127.0.0.1:9/authorize',
        OAUTH_GOOGLE_TOKEN_URL: 'http://127.0.0.1:9/token',
        OAUTH_GOOGLE_SCOPES: 'a,b',
        OAUTH_GOOGLE_PKCE: 'false',
      },
      REDIRECT,
    );
    const google = reg.get('google');
    expect(google?.authUrl).toBe('http://127.0.0.1:9/authorize');
    expect(google?.scopes).toEqual(['a', 'b']);
    expect(google?.usePkce).toBe(false);
  });
});

describe('OAuthProvidersService', () => {
  const svc = new OAuthProvidersService(
    loadOAuthProviders({ OAUTH_SLACK_CLIENT_ID: 'sid', OAUTH_SLACK_CLIENT_SECRET: 'ssecret' }, REDIRECT),
  );

  it('get() returns null for an unconfigured provider', () => {
    expect(svc.get('google')).toBeNull();
    expect(svc.get('slack')).not.toBeNull();
  });

  it('list() exposes configured providers without secrets', () => {
    const list = svc.list();
    expect(list).toEqual([{ provider: 'slack', scopes: ['chat:write'] }]);
    expect(JSON.stringify(list)).not.toContain('ssecret');
  });

  it('redirectUri defaults to empty and is carried when supplied', () => {
    expect(svc.redirectUri).toBe('');
    expect(new OAuthProvidersService(new Map(), REDIRECT).redirectUri).toBe(REDIRECT);
  });
});

// ─── BYO OAuth own-client (ADR 0042) ───

describe('byoClientToConfig', () => {
  const byo: ByoOAuthClient = {
    clientId: 'cid',
    clientSecret: 'csecret',
    authUrl: 'https://app.test/authorize',
    tokenUrl: 'https://app.test/token',
    scopes: ['read'],
    usePkce: true,
  };

  it('builds a provider config that runs the standard flow', () => {
    const cfg = byoClientToConfig('byoapp', byo, REDIRECT);
    expect(cfg).toEqual({
      provider: 'byoapp',
      authUrl: 'https://app.test/authorize',
      tokenUrl: 'https://app.test/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      scopes: ['read'],
      redirectUri: REDIRECT,
      usePkce: true,
      authExtraParams: {},
    });
  });
});

describe('parseByoClient', () => {
  const valid = JSON.stringify({
    clientId: 'cid',
    clientSecret: 'csecret',
    authUrl: 'https://app.test/authorize',
    tokenUrl: 'https://app.test/token',
    scopes: ['read', 'write'],
    usePkce: false,
  });

  it('round-trips a valid stored client', () => {
    expect(parseByoClient(valid)).toEqual({
      clientId: 'cid',
      clientSecret: 'csecret',
      authUrl: 'https://app.test/authorize',
      tokenUrl: 'https://app.test/token',
      scopes: ['read', 'write'],
      usePkce: false,
    });
  });

  it('defaults usePkce on and scopes to [] when absent', () => {
    const c = parseByoClient(
      JSON.stringify({ clientId: 'c', clientSecret: 's', authUrl: 'a', tokenUrl: 't' }),
    );
    expect(c?.usePkce).toBe(true);
    expect(c?.scopes).toEqual([]);
  });

  it('returns null for corrupt / incomplete blobs (degrade, never throw)', () => {
    expect(parseByoClient('not json')).toBeNull();
    expect(parseByoClient('null')).toBeNull();
    expect(parseByoClient(JSON.stringify({ clientId: 'c' }))).toBeNull(); // missing secret/urls
  });
});

describe('assertSafeOAuthEndpoint (store-time BYO endpoint guard)', () => {
  // The default test env allowlists loopback, so these cases use non-allowlisted literals —
  // no live DNS needed, deterministic offline.

  it('rejects a non-https endpoint (public host, not allowlisted)', async () => {
    await expect(assertSafeOAuthEndpoint('token_url', 'http://example.com/token')).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(assertSafeOAuthEndpoint('token_url', 'http://example.com/token')).rejects.toThrow(
      /must use https/,
    );
  });

  it('rejects a private / cloud-metadata address even over https', async () => {
    await expect(assertSafeOAuthEndpoint('token_url', 'https://169.254.169.254/token')).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(assertSafeOAuthEndpoint('token_url', 'https://169.254.169.254/token')).rejects.toThrow(
      /private or internal/,
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(assertSafeOAuthEndpoint('authorization_url', 'not a url')).rejects.toThrow(
      /not a valid URL/,
    );
  });

  it('accepts a public https endpoint', async () => {
    // Public IP literal → no DNS, guard passes, https satisfied.
    await expect(assertSafeOAuthEndpoint('token_url', 'https://8.8.8.8/token')).resolves.toBeUndefined();
  });

  it('accepts an allowlisted loopback endpoint over http (self-host / test escape hatch)', async () => {
    // 127.0.0.1 is in the default test allowlist, which also lifts the https rule.
    await expect(assertSafeOAuthEndpoint('token_url', 'http://127.0.0.1:9/token')).resolves.toBeUndefined();
  });
});
