import { OidcUnavailableError, parseDiscovery } from './oidc-relying-party';

const ISSUER = 'https://login.example.com/';

const document = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  issuer: ISSUER,
  authorization_endpoint: 'https://login.example.com/authorize',
  token_endpoint: 'https://login.example.com/token',
  jwks_uri: 'https://login.example.com/keys',
  ...over,
});

describe('parseDiscovery', () => {
  it('takes the endpoints, defaults to Basic client auth and every accepted algorithm when nothing narrows them', () => {
    expect(parseDiscovery(document(), ISSUER, true)).toEqual({
      authorizationEndpoint: 'https://login.example.com/authorize',
      tokenEndpoint: 'https://login.example.com/token',
      jwksUri: 'https://login.example.com/keys',
      userinfoEndpoint: null,
      algorithms: ['RS256', 'PS256', 'ES256'],
      clientAuth: 'client_secret_basic',
      issParameter: false,
      promptLogin: false,
    });
  });

  it('reads prompt=login as supported only when the provider lists it among its prompt values', () => {
    const listed = (values: unknown) =>
      parseDiscovery(document({ prompt_values_supported: values }), ISSUER, true).promptLogin;
    expect([listed(['none', 'login']), listed(['none', 'consent']), listed('login')]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('narrows the algorithms to the ones the provider lists, and uses client_secret_post only when it lists nothing else', () => {
    const parsed = parseDiscovery(
      document({
        id_token_signing_alg_values_supported: ['ES256', 'HS256', 'none'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt'],
      }),
      ISSUER,
      true,
    );
    expect(parsed.algorithms).toEqual(['ES256']);
    expect(parsed.clientAuth).toBe('client_secret_post');
  });

  it('in production refuses a plain-http endpoint unless it reaches only this machine', () => {
    const plain = document({ token_endpoint: 'http://login.example.com/token' });
    expect(() => parseDiscovery(plain, ISSUER, true)).toThrow(
      new OidcUnavailableError(
        "the discovery document's token_endpoint is plain http, which production refuses",
      ),
    );
    expect(() => parseDiscovery(plain, ISSUER, false)).not.toThrow();
    for (const local of [
      'http://127.0.0.1:9000/token',
      'http://localhost:9000/token',
      'http://[::1]:9000/token',
    ]) {
      expect(() => parseDiscovery(document({ token_endpoint: local }), ISSUER, true)).not.toThrow();
    }
  });

  it('refuses a userinfo endpoint that is not a URL, rather than ignoring it', () => {
    expect(() => parseDiscovery(document({ userinfo_endpoint: 'ftp://x' }), ISSUER, false)).toThrow(
      /userinfo_endpoint is missing or not an http\(s\) URL/,
    );
  });
});
