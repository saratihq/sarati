import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { OAuthProviderConfig } from './oauth-providers';
import { exchangeAuthorizationCode, OAuthExchangeError, refreshAccessToken } from './oauth-token';

/** Runs a throwaway token endpoint; the test controls the status + body it returns. */
describe('exchangeAuthorizationCode', () => {
  let server: Server;
  let tokenUrl: string;
  let lastBody = '';
  let respond: () => { status: number; body: string } = () => ({ status: 200, body: '{}' });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastBody = Buffer.concat(chunks).toString('utf8');
        const { status, body } = respond();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const cfg = (): OAuthProviderConfig => ({
    provider: 'acme',
    authUrl: 'http://unused/authorize',
    tokenUrl,
    clientId: 'cid',
    clientSecret: 'csecret',
    scopes: ['read'],
    redirectUri: 'http://app/callback',
    usePkce: true,
    authExtraParams: {},
  });

  it('POSTs a form-encoded authorization_code grant and parses the token set', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });
    const tokens = await exchangeAuthorizationCode(cfg(), 'the-code', 'verifier-xyz');

    const params = new URLSearchParams(lastBody);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('redirect_uri')).toBe('http://app/callback');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('csecret');
    expect(params.get('code_verifier')).toBe('verifier-xyz'); // PKCE

    expect(tokens.access_token).toBe('at-1');
    expect(tokens.refresh_token).toBe('rt-1');
    expect(tokens.expires_in).toBe(3600);
  });

  it('omits the code_verifier when PKCE is off', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ access_token: 'at' }) });
    await exchangeAuthorizationCode({ ...cfg(), usePkce: false }, 'c', 'verifier');
    expect(new URLSearchParams(lastBody).get('code_verifier')).toBeNull();
  });

  it('throws OAuthExchangeError on a non-2xx token response', async () => {
    respond = () => ({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) });
    await expect(exchangeAuthorizationCode(cfg(), 'bad', 'v')).rejects.toThrow(OAuthExchangeError);
  });

  it('throws when the body carries no access_token (e.g. Slack ok:false)', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: false, error: 'invalid_code' }) });
    await expect(exchangeAuthorizationCode(cfg(), 'c', 'v')).rejects.toThrow(/no access_token/i);
  });
});

/**
 * SSRF guard at the single token-endpoint choke point: a fully user-supplied BYO `token_url` must be blocked on
 * BOTH grants before any request leaves the process — proven by a real loopback server whose hit count stays zero.
 */
describe('postToken SSRF guard (both grant paths)', () => {
  let server: Server;
  let tokenUrl: string;
  let hits = 0;
  const savedAllowlist = process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1; // any request that reaches the socket counts
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'unit-token', token_type: 'Bearer', expires_in: 3600 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    // Restore the default test allowlist for any later suites.
    if (savedAllowlist === undefined) delete process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;
    else process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = savedAllowlist;
  });

  beforeEach(() => {
    hits = 0;
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = ''; // blank it so the guard is live here
  });

  const cfg = (url: string): OAuthProviderConfig => ({
    provider: 'byoapp',
    authUrl: 'https://example.com/authorize',
    tokenUrl: url,
    clientId: 'cid',
    clientSecret: 'secret',
    scopes: ['read'],
    redirectUri: 'https://app.example.com/cb',
    usePkce: false,
    authExtraParams: {},
  });

  it('blocks a loopback token endpoint on the code-exchange path with NO outbound request', async () => {
    await expect(exchangeAuthorizationCode(cfg(tokenUrl), 'code-1', null)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
    expect(hits).toBe(0);
  });

  it('blocks the same endpoint on the REFRESH path with NO outbound request', async () => {
    await expect(refreshAccessToken(cfg(tokenUrl), 'refresh-token-1')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
    expect(hits).toBe(0);
  });

  it('lets an allowlisted host through the guard and reaches the server', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const tokens = await exchangeAuthorizationCode(cfg(tokenUrl), 'code-1', null);
    expect(tokens.access_token).toBe('unit-token');
    expect(hits).toBe(1);
  });
});
