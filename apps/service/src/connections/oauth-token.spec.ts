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

/** The token exchange rides the SDK's guarded hop: it refuses a private endpoint before any request, never follows a redirect, and never mistakes a network failure for a provider's refusal. */
describe('postToken SSRF guard and failure classes (both grant paths)', () => {
  let server: Server;
  let tokenUrl: string;
  let paths: string[] = [];
  const savedAllowlist = process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;

  beforeAll(async () => {
    server = createServer((req, res) => {
      paths.push(req.url ?? '');
      const { port } = server.address() as AddressInfo;
      if (req.url?.endsWith('?redirect=1')) {
        res.writeHead(307, { location: `http://localhost:${port}/elsewhere` });
        res.end();
        return;
      }
      if (req.url?.endsWith('?redirect=bare')) {
        res.writeHead(302);
        res.end();
        return;
      }
      if (req.url?.endsWith('?verbose=1')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: `Bearer abcdefghijklmnop ${'y'.repeat(1000)}`,
          }),
        );
        return;
      }
      const status = /[?&]status=(\d+)/.exec(req.url ?? '')?.[1];
      if (status) {
        res.writeHead(Number(status), { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporarily_unavailable', error_description: 'try later' }));
        return;
      }
      if (req.url?.endsWith('?html=1')) {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end(`<html>Bearer abcdefghijklmnop ${'x'.repeat(1000)}</html>`);
        return;
      }
      if (req.url?.endsWith('?nested=1')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            authed_user: { access_token: 'xoxp-NESTED-SECRET', refresh_token: 'NESTED-REFRESH' },
          }),
        );
        return;
      }
      if (req.url?.endsWith('?hang=1')) return;
      if (req.url?.endsWith('?truncate=1')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"access_', () => setTimeout(() => res.socket?.destroy(), 50));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'unit-token', token_type: 'Bearer', expires_in: 3600 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    // Restore the default test allowlist for any later suites.
    if (savedAllowlist === undefined) delete process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;
    else process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = savedAllowlist;
  });

  beforeEach(() => {
    paths = [];
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
    expect(paths).toEqual([]);
  });

  it('blocks the same endpoint on the REFRESH path with NO outbound request', async () => {
    await expect(refreshAccessToken(cfg(tokenUrl), 'refresh-token-1')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
    expect(paths).toEqual([]);
  });

  it('never follows a redirect, and names where it pointed instead of calling it a refusal', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
    const { port } = server.address() as AddressInfo;
    const failure = await refreshAccessToken(cfg(`${tokenUrl}?redirect=1`), 'refresh-token-1').catch(
      (err: unknown) => err,
    );
    expect(failure).not.toBeInstanceOf(OAuthExchangeError);
    expect(failure).toMatchObject({
      code: 'http_error',
      retryable: false,
      message: `the token endpoint http://127.0.0.1:${port} redirected (307) to http://localhost:${port}/elsewhere; use that URL as the token URL, since a token endpoint must answer directly`,
    });
    expect(paths).toEqual(['/token?redirect=1']);
  });

  it('says a redirect without a Location went nowhere it named, rather than back to itself', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const { port } = server.address() as AddressInfo;
    await expect(refreshAccessToken(cfg(`${tokenUrl}?redirect=bare`), 'rt')).rejects.toMatchObject({
      code: 'http_error',
      message: `the token endpoint http://127.0.0.1:${port} redirected (302) without saying where; a token endpoint must answer directly`,
    });
  });

  it.each([['503'], ['429'], ['408']])(
    'calls a %s from the token endpoint a retryable outage, not a refusal',
    async (status) => {
      process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
      const failure = await refreshAccessToken(cfg(`${tokenUrl}?status=${status}`), 'rt').catch(
        (err: unknown) => err,
      );
      expect(failure).not.toBeInstanceOf(OAuthExchangeError);
      expect(failure).toMatchObject({
        code: 'provider_error',
        retryable: true,
        message: expect.stringContaining(`answered ${status}: temporarily_unavailable: try later`),
      });
    },
  );

  it('calls another 4xx a configuration problem with the token URL, not a refusal', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const failure = await refreshAccessToken(cfg(`${tokenUrl}?status=404`), 'rt').catch(
      (err: unknown) => err,
    );
    expect(failure).not.toBeInstanceOf(OAuthExchangeError);
    expect(failure).toMatchObject({
      code: 'http_error',
      retryable: false,
      message: expect.stringContaining('check the token URL'),
    });
  });

  it('keeps a 400 a refusal of the grant, saying what the provider said', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const failure = refreshAccessToken(cfg(`${tokenUrl}?status=400`), 'rt');
    await expect(failure).rejects.toBeInstanceOf(OAuthExchangeError);
    await expect(failure).rejects.toThrow(
      'Token endpoint refused the grant (400): temporarily_unavailable: try later',
    );
  });

  it('never echoes a token from a reply with no top-level access_token', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const failure = await exchangeAuthorizationCode(cfg(`${tokenUrl}?nested=1`), 'code-1', null).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(OAuthExchangeError);
    expect((failure as Error).message).toBe(
      'Token endpoint returned no access_token: a reply with fields ok, authed_user',
    );
  });

  it('bounds and redacts what a refusal quotes from the provider', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const failure = (await refreshAccessToken(cfg(`${tokenUrl}?verbose=1`), 'rt').catch(
      (err: unknown) => err,
    )) as Error;
    expect(failure).toBeInstanceOf(OAuthExchangeError);
    expect(failure.message).toMatch(
      /^Token endpoint refused the grant \(400\): invalid_grant: Bearer \[redacted\] y+$/,
    );
    expect(failure.message.length).toBeLessThan(300);
  });

  it('bounds and redacts a non-JSON error body', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const failure = (await refreshAccessToken(cfg(`${tokenUrl}?html=1`), 'rt').catch(
      (err: unknown) => err,
    )) as Error;
    expect(failure.message.length).toBeLessThan(400);
    expect(failure.message).not.toContain('abcdefghijklmnop');
  });

  it('calls a token endpoint that never answers a timeout naming it, not a refusal', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const { port } = server.address() as AddressInfo;
    const failure = await refreshAccessToken(cfg(`${tokenUrl}?hang=1`), 'rt').catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(OAuthExchangeError);
    expect(failure).toMatchObject({
      code: 'transport_timeout',
      message: `the token endpoint http://127.0.0.1:${port} did not answer within 30s`,
    });
  }, 45_000);

  it('lets a body that breaks off mid-read surface as a network failure, not as "no access_token"', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const failure = await refreshAccessToken(cfg(`${tokenUrl}?truncate=1`), 'refresh-token-1').catch(
      (err: unknown) => err,
    );
    expect(failure).not.toBeInstanceOf(OAuthExchangeError);
    expect(failure).toMatchObject({
      code: 'transport_interrupted',
      message: expect.stringContaining('broke while reading the token response'),
    });
  });

  it('keeps an unreachable endpoint a network failure that says why, never a provider refusal', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const failure = await refreshAccessToken(cfg(`http://127.0.0.1:${port}/token`), 'rt').catch(
      (err: unknown) => err,
    );
    expect(failure).not.toBeInstanceOf(OAuthExchangeError);
    expect(failure).toMatchObject({
      code: 'transport_unreachable',
      message: `could not reach http://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port}`,
    });
  });

  it('lets an allowlisted host through the guard and reaches the server', async () => {
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const tokens = await exchangeAuthorizationCode(cfg(tokenUrl), 'code-1', null);
    expect(tokens.access_token).toBe('unit-token');
    expect(paths).toEqual(['/token']);
  });
});
