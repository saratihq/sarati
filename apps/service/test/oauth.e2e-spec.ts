import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
// The access token the fake provider mints; the fake resource server demands it.
const ACCESS_TOKEN = 'oauth-access-token-abc';
// Minted by the refresh_token grant (the rotation test).
const REFRESHED_TOKEN = 'oauth-access-token-refreshed';
const REFRESH_TOKEN = 'oauth-refresh-token-1';
const REDIRECT_URI = 'http://localhost:3100/integrations/callback';

/** OAuth2 authorization-code flow for managed connections, end to end against a throwaway provider. */
describe('oauth connection flow (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let providerServer: Server;
  let providerUrl: string;
  let lastTokenBody = '';
  let refreshGrants = 0;
  /** Every request the fake provider receives — proves a blocked flow never fetches. */
  let providerHits = 0;
  /** What the fake provider answers to refresh grants (the health tests break it). */
  let refreshReply: 'ok' | 'invalid_grant' = 'ok';
  const savedOauthEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);

    // The registry must contain EXACTLY the fake "acme" provider, so blank every inherited
    // OAUTH_* var (environment or .env) before app init and restore it in afterAll.
    let envFile = '';
    try {
      envFile = readFileSync('.env', 'utf8');
    } catch {
      // no .env — nothing declared there
    }
    const inheritedKeys = new Set<string>([
      ...[...envFile.matchAll(/^\s*(OAUTH_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1] as string),
      ...Object.keys(process.env).filter((k) => k.startsWith('OAUTH_')),
    ]);
    for (const key of inheritedKeys) {
      if (key.startsWith('OAUTH_ACME_') || key === 'OAUTH_REDIRECT_URI') continue;
      savedOauthEnv.set(key, process.env[key]);
      process.env[key] = '';
    }

    // Fake provider: /token mints (and refreshes) the access token.
    providerServer = createServer((req, res) => {
      providerHits += 1;
      if (req.url === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          lastTokenBody = Buffer.concat(chunks).toString('utf8');
          const grant = new URLSearchParams(lastTokenBody);
          if (grant.get('grant_type') === 'refresh_token') {
            refreshGrants += 1;
            if (refreshReply === 'invalid_grant') {
              // The provider revoked the refresh token — the standard reply.
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                access_token: REFRESHED_TOKEN,
                token_type: 'Bearer',
                expires_in: 3600,
              }),
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          // `auth-code-expiring` mints a near-expired token with a refresh token; `auth-code-expired` an expired one.
          const expiring = grant.get('code') === 'auth-code-expiring';
          const expired = grant.get('code') === 'auth-code-expired';
          res.end(
            JSON.stringify({
              access_token: ACCESS_TOKEN,
              token_type: 'Bearer',
              expires_in: expired ? -60 : expiring ? 30 : 3600,
              ...(expiring || expired ? { refresh_token: REFRESH_TOKEN } : {}),
              scope: 'read:data',
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

    // Set before app init so the OAuthProviders factory picks "acme" up.
    process.env.OAUTH_ACME_CLIENT_ID = 'acme-client';
    process.env.OAUTH_ACME_CLIENT_SECRET = 'acme-secret';
    process.env.OAUTH_ACME_AUTH_URL = `${providerUrl}/authorize`;
    process.env.OAUTH_ACME_TOKEN_URL = `${providerUrl}/token`;
    process.env.OAUTH_ACME_SCOPES = 'read:data';
    process.env.OAUTH_REDIRECT_URI = REDIRECT_URI;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    // The APP_GUARD ThrottlerGuard can't be overridden by token, so stub its storage to never block.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => providerServer.close((e) => (e ? reject(e) : resolve())));
    for (const k of [
      'OAUTH_ACME_CLIENT_ID',
      'OAUTH_ACME_CLIENT_SECRET',
      'OAUTH_ACME_AUTH_URL',
      'OAUTH_ACME_TOKEN_URL',
      'OAUTH_ACME_SCOPES',
      'OAUTH_REDIRECT_URI',
    ]) {
      delete process.env[k];
    }
    for (const [k, v] of savedOauthEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('lists the configured provider (no secrets)', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections/oauth/providers').expect(200);
    expect(res.body).toEqual([{ provider: 'acme', scopes: ['read:data'] }]);
    expect(JSON.stringify(res.body)).not.toContain('acme-secret');
  });

  it('authorize builds a consent URL with the right params + PKCE', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({ provider: 'acme' })
      .expect(201);
    expect(typeof res.body.state).toBe('string');

    const url = new URL(res.body.authorize_url);
    expect(url.origin + url.pathname).toBe(`${providerUrl}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('acme-client');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('read:data');
    expect(url.searchParams.get('state')).toBe(res.body.state);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('rejects authorize for an unconfigured provider', async () => {
    await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({ provider: 'google' })
      .expect(400);
  });

  /** The mock-auth user id that owns connections created via the API. */
  async function currentUserId(): Promise<string> {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    return me.body.user.id as string;
  }

  it('callback exchanges the code, stores an oauth2 connection, and it resolves to a real Bearer token', async () => {
    // The browser step is simulated — authorize, then straight to callback.
    const auth = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({ provider: 'acme' })
      .expect(201);
    const state = auth.body.state as string;

    const cb = await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code: 'auth-code-1', state })
      .expect(201);
    expect(cb.body.status).toBe('connected');
    expect(cb.body.connection.auth_type).toBe('oauth2');
    expect(cb.body.connection.provider).toBe('acme');
    expect(JSON.stringify(cb.body)).not.toContain(ACCESS_TOKEN); // token never returned
    const connectionId = cb.body.connection.id as string;

    // The token endpoint received a proper PKCE authorization_code grant.
    const grant = new URLSearchParams(lastTokenBody);
    expect(grant.get('grant_type')).toBe('authorization_code');
    expect(grant.get('code')).toBe('auth-code-1');
    expect(grant.get('code_verifier')).toBeTruthy();

    // The secret is only ever materialized at resolution — never returned over the API or held in the plan.
    const cred = (await app.get(ConnectionsService).getCredential(await currentUserId(), connectionId)) as {
      access_token?: string;
    };
    expect(cred.access_token).toBe(ACCESS_TOKEN);
  });

  it('refreshes a near-expired oauth2 token at run time, persists it, and refreshes ONCE', async () => {
    // A token expiring in 30s is inside the 60s skew, so the first resolution must refresh.
    const auth = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({ provider: 'acme' })
      .expect(201);
    const cb = await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code: 'auth-code-expiring', state: auth.body.state })
      .expect(201);
    const connectionId = cb.body.connection.id as string;
    const connections = app.get(ConnectionsService);
    const userId = await currentUserId();

    // First resolution (what a run does): the near-expired token is refreshed.
    expect(refreshGrants).toBe(0);
    const first = (await connections.getCredential(userId, connectionId)) as { access_token?: string };
    expect(first.access_token).toBe(REFRESHED_TOKEN);
    expect(refreshGrants).toBe(1);

    // The refresh grant carried the stored refresh token + client creds.
    const grant = new URLSearchParams(lastTokenBody);
    expect(grant.get('grant_type')).toBe('refresh_token');
    expect(grant.get('refresh_token')).toBe(REFRESH_TOKEN);

    // Second resolution uses the PERSISTED rotated token — no second refresh.
    const second = (await connections.getCredential(userId, connectionId)) as { access_token?: string };
    expect(second.access_token).toBe(REFRESHED_TOKEN);
    expect(refreshGrants).toBe(1);
  });

  // ─── Connection health (H4): the test probe + run-time status transitions ───

  /** Mint an acme oauth2 connection via the full authorize → callback flow. */
  async function mintConnection(code: string): Promise<string> {
    const auth = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({ provider: 'acme' })
      .expect(201);
    const cb = await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code, state: auth.body.state })
      .expect(201);
    return cb.body.connection.id as string;
  }

  async function listedRow(id: string): Promise<Record<string, unknown>> {
    const list = await request(app.getHttpServer()).get('/api/connections').expect(200);
    return list.body.find((c: { id: string }) => c.id === id);
  }

  it('test probe forces a refresh grant when one exists and reports renewed access', async () => {
    const id = await mintConnection('auth-code-expiring');
    const before = refreshGrants;
    const res = await request(app.getHttpServer()).post(`/api/connections/${id}/test`).expect(200);
    expect(res.body).toMatchObject({ ok: true, status: 'active' });
    expect(res.body.detail).toContain('renewed');
    expect(refreshGrants).toBe(before + 1); // the probe actually redeemed the grant

    const row = await listedRow(id);
    expect(row).toMatchObject({ status: 'active', status_reason: null });
    expect(typeof row.last_checked_at).toBe('string');
  });

  it('a declined refresh flips the row to expired with a plain-language reason — and a later probe heals it', async () => {
    const id = await mintConnection('auth-code-expiring');
    refreshReply = 'invalid_grant';
    const res = await request(app.getHttpServer()).post(`/api/connections/${id}/test`).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('expired');
    // Product copy, never the raw provider error (that goes to the log).
    expect(res.body.detail).toBe('The provider declined to renew access — reconnect this account.');
    expect(JSON.stringify(res.body)).not.toContain('invalid_grant');
    expect(await listedRow(id)).toMatchObject({
      status: 'expired',
      status_reason: 'The provider declined to renew access — reconnect this account.',
    });

    // Recovery: the provider accepts refreshes again → the same probe heals the row.
    refreshReply = 'ok';
    const again = await request(app.getHttpServer()).post(`/api/connections/${id}/test`).expect(200);
    expect(again.body).toMatchObject({ ok: true, status: 'active' });
    expect(await listedRow(id)).toMatchObject({ status: 'active', status_reason: null });
  });

  it('a failed RUN-TIME refresh of an expired token persists the expired status (H4 failure path)', async () => {
    const id = await mintConnection('auth-code-expired'); // hard-expired at mint
    refreshReply = 'invalid_grant';
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    // Credential resolution (what every run does) both throws AND records why.
    await expect(app.get(ConnectionsService).getCredential(me.body.user.id, id)).rejects.toThrow(
      /token refresh failed/,
    );
    refreshReply = 'ok';
    expect(await listedRow(id)).toMatchObject({
      status: 'expired',
      status_reason: 'The provider declined to renew access — reconnect this account.',
    });
  });

  it('test probe without a refresh token is honest: expiry check only, no grant redeemed', async () => {
    const id = await mintConnection('auth-code-1'); // 1h token, NO refresh token
    const before = refreshGrants;
    const res = await request(app.getHttpServer()).post(`/api/connections/${id}/test`).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.detail).toContain('cannot be verified with the provider');
    expect(refreshGrants).toBe(before); // nothing was redeemed
  });

  it('rejects a callback with an unknown state, and a replayed (single-use) state', async () => {
    await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code: 'c', state: 'never-issued' })
      .expect(400);

    const auth = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({ provider: 'acme' })
      .expect(201);
    const state = auth.body.state as string;
    await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code: 'c', state })
      .expect(201);
    // Same state again → consumed → 400.
    await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code: 'c', state })
      .expect(400);
  });

  // ─── BYO OAuth own-client (A2) — `byoapp` is NOT env-configured ───

  const BYO_CLIENT = {
    client_id: 'byo-client',
    client_secret: 'byo-secret',
    scopes: ['read:data'],
  };

  it('authorize with a BYO own-client works for an UNconfigured provider', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({
        provider: 'byoapp',
        oauth_client: {
          ...BYO_CLIENT,
          auth_url: `${providerUrl}/authorize`,
          token_url: `${providerUrl}/token`,
        },
      })
      .expect(201);

    const url = new URL(res.body.authorize_url);
    expect(url.origin + url.pathname).toBe(`${providerUrl}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('byo-client'); // the user's OWN client
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge')).toBeTruthy(); // PKCE on by default
    expect(JSON.stringify(res.body)).not.toContain('byo-secret'); // secret never returned
  });

  /** Full BYO authorize → callback → connection, returning its id. */
  async function mintByoConnection(code: string): Promise<string> {
    const auth = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({
        provider: 'byoapp',
        oauth_client: {
          ...BYO_CLIENT,
          auth_url: `${providerUrl}/authorize`,
          token_url: `${providerUrl}/token`,
        },
      })
      .expect(201);
    const cb = await request(app.getHttpServer())
      .post('/api/connections/oauth/callback')
      .send({ code, state: auth.body.state })
      .expect(201);
    expect(cb.body.connection.auth_type).toBe('oauth2');
    expect(cb.body.connection.provider).toBe('byoapp');
    expect(JSON.stringify(cb.body)).not.toContain('byo-secret'); // still no secret
    return cb.body.connection.id as string;
  }

  it('callback exchanges the code against the BYO client and stores an oauth2 connection', async () => {
    const id = await mintByoConnection('auth-code-1');
    const grant = new URLSearchParams(lastTokenBody);
    expect(grant.get('grant_type')).toBe('authorization_code');
    expect(grant.get('client_id')).toBe('byo-client'); // exchanged against the OWN client
    expect(grant.get('client_secret')).toBe('byo-secret');

    const cred = (await app.get(ConnectionsService).getCredential(await currentUserId(), id)) as {
      access_token?: string;
    };
    expect(cred.access_token).toBe(ACCESS_TOKEN);
  });

  it('refresh redeems against the STORED BYO client (own-client retained for refresh)', async () => {
    const id = await mintByoConnection('auth-code-expiring'); // near-expired + refresh token
    const connections = app.get(ConnectionsService);
    const userId = await currentUserId();
    const before = refreshGrants;

    const cred = (await connections.getCredential(userId, id)) as { access_token?: string };
    expect(cred.access_token).toBe(REFRESHED_TOKEN); // the refresh happened
    expect(refreshGrants).toBe(before + 1);

    // The refresh grant carried the user's OWN client creds, not any env client.
    const grant = new URLSearchParams(lastTokenBody);
    expect(grant.get('grant_type')).toBe('refresh_token');
    expect(grant.get('client_id')).toBe('byo-client');
    expect(grant.get('client_secret')).toBe('byo-secret');
  });

  // ─── Store-time SSRF / scheme guard on the user-supplied endpoints ───
  // 127.0.0.1 is allowlisted for the loopback fake provider, so these cases use non-allowlisted addresses.

  it('rejects a BYO token_url that resolves to a private/metadata address — with NO outbound request', async () => {
    const before = providerHits;
    const res = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({
        provider: 'byoapp',
        oauth_client: {
          ...BYO_CLIENT,
          auth_url: 'https://8.8.8.8/authorize', // public https, so token_url is what fails
          token_url: 'https://169.254.169.254/token', // https + link-local cloud metadata
        },
      })
      .expect(400);
    expect(res.body.detail).toMatch(/token_url must not point at a private or internal address/);
    // The flow is rejected at authorize, before any state is minted or fetched.
    expect(providerHits).toBe(before);
  });

  it('rejects a BYO auth_url that is not https (a browser-redirect URL, guarded only at store time)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/connections/oauth/authorize')
      .send({
        provider: 'byoapp',
        oauth_client: {
          ...BYO_CLIENT,
          auth_url: 'http://8.8.8.8/authorize', // non-https
          token_url: 'https://8.8.8.8/token', // valid, so auth_url is what fails
        },
      })
      .expect(400);
    expect(res.body.detail).toMatch(/authorization_url must use https/);
  });
});
