import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { jwtVerify } from 'jose';
import request from 'supertest';

import { AppModule } from '../app.module';
import { trustProxies } from '../common/trust-proxies';
import type { EnvConfig } from '../config/env.config';
import { mintLocalSession } from '../testing/local-session';

/**
 * The self-host capability contract, exercised over real HTTP against a real
 * boot — including a real workflow-service stub, because the Anthropic key now
 * comes from that service's store rather than this process's environment.
 *
 * Three regressions it guards, all of which made the composer unreachable on a
 * self-host: a crash-loop without a key, a guard that only spoke Clerk so every
 * local-session caller 401'd, and a key that only took effect after a restart.
 */

/** Stands in for the value entrypoint.sh generates onto the shared data volume. */
const SECRET = 'shared-secret-off-the-data-volume';

/** What the workflow-service stub currently has stored; mutated mid-test, never re-booted. */
let storedKey: string | null = null;
let serviceStub: Server;
let serviceUrl: string;
/** Every internal token the stub saw, so it can be asserted rather than assumed. */
let internalAuth: string[] = [];
/** The X-Forwarded-For each key read carried — the address workflow-service counts its limits against. */
let forwardedFor: string[] = [];
/** Whether the stub answers key reads as workflow-service does once a caller's limit is spent. */
let rateLimited = false;

/** A signed-in caller — the composer answers about THEM, so every probe carries one. */
let callerToken = '';

function asCaller(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${callerToken}`);
}

beforeAll(async () => {
  serviceStub = createServer((req, res) => {
    void (async () => {
      if (req.url !== '/api/internal/platform-keys/anthropic') {
        res.writeHead(404).end();
        return;
      }
      // Both credentials, exactly as workflow-service requires: the CALLER's own bearer
      // decides whose key comes back, the internal token proves this is the agent process.
      const caller = req.headers.authorization ?? '';
      const internal = (req.headers['x-internal-token'] as string | undefined) ?? '';
      internalAuth.push(internal);
      forwardedFor.push((req.headers['x-forwarded-for'] as string | undefined) ?? '');
      if (rateLimited) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Rate limit exceeded. Please try again later.' }));
        return;
      }
      if (!caller.startsWith('Bearer ')) {
        res.writeHead(401).end();
        return;
      }
      try {
        // As workflow-service verifies it: minted for this purpose, and for the caller it rides beside.
        const { payload } = await jwtVerify(internal, new TextEncoder().encode(SECRET), {
          issuer: 'orchestr:internal',
          audience: 'platform-keys:anthropic',
          algorithms: ['HS256'],
        });
        const bearer = caller.slice('Bearer '.length);
        if (payload.sub !== createHash('sha256').update(bearer).digest('base64url'))
          throw new Error('unbound');
      } catch {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ api_key: storedKey }));
    })();
  });
  await new Promise<void>((resolve) => serviceStub.listen(0, '127.0.0.1', resolve));
  serviceUrl = `http://127.0.0.1:${(serviceStub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => serviceStub.close(resolve));
});

const BASE_ENV = {
  ENVIRONMENT: 'development',
  PORT: '8010',
};

const localToken = (
  over: {
    secret?: string;
    sub?: string;
    issuer?: string;
    lifetime?: number;
    claims?: Record<string, unknown>;
  } = {},
): Promise<string> => mintLocalSession(over.secret ?? SECRET, over.sub ?? 'user_selfhost_1', over);

async function boot(overrides: Record<string, string>): Promise<INestApplication> {
  process.env = { PATH: process.env.PATH, ...BASE_ENV, WORKFLOW_SERVICE_URL: serviceUrl, ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  trustProxies(
    app,
    app.get(ConfigService<{ env: EnvConfig }, true>).get('env', { infer: true }).trustProxyHops,
  );
  // An exclusive loopback port: supertest's own listen(0) on the IPv6 wildcard can collide with a 127.0.0.1 socket.
  await app.listen(0, '127.0.0.1');
  return app;
}

describe('composer availability', () => {
  const realEnv = process.env;
  let app: INestApplication | null = null;

  beforeEach(async () => {
    storedKey = null;
    internalAuth = [];
    forwardedFor = [];
    rateLimited = false;
    callerToken = await localToken();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    process.env = realEnv;
  });

  describe('no credentials at all', () => {
    it('boots instead of throwing, and names the shared secret first', async () => {
      app = await boot({});

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      // Auth comes FIRST now: the Anthropic key is set in Settings, and nobody can sign in
      // to reach Settings — or read the store — until SECRET_KEY is shared.
      expect(res.body).toEqual({
        status: 'disabled',
        reason: 'caller_auth_unconfigured',
        message: expect.stringContaining('SECRET_KEY'),
        docs: expect.any(String),
      });
    });

    it('503s the functional endpoints with the reason, ahead of auth', async () => {
      app = await boot({});

      // No Authorization header: the 401 would be the misleading answer here.
      const res = await asCaller(request(app.getHttpServer()).post('/api/composer/stream'))
        .send({ message: 'build me a workflow' })
        .expect(503);

      expect(res.body).toMatchObject({ reason: 'caller_auth_unconfigured' });
    });

    it('503s a malformed body too — the gate is not behind validation', async () => {
      app = await boot({});

      await asCaller(request(app.getHttpServer()).post('/api/composer/stream')).send({}).expect(503);
    });

    it('keeps /api/health answering — the container HEALTHCHECK depends on it', async () => {
      app = await boot({});

      await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
    });
  });

  describe('a stored key but no caller auth', () => {
    it('stays disabled rather than serving an unauthenticated composer', async () => {
      storedKey = 'sk-test';
      app = await boot({});

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      expect(res.body).toMatchObject({
        status: 'disabled',
        reason: 'caller_auth_unconfigured',
        message: expect.stringContaining('CLERK_ISSUER'),
      });
      await asCaller(request(app.getHttpServer()).post('/api/composer/stream'))
        .send({ message: 'hi' })
        .expect(503);
    });

    it('Clerk without the shared secret is still disabled — the store is unreadable', async () => {
      storedKey = 'sk-test';
      app = await boot({ CLERK_ISSUER: 'https://clerk.example' });

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      expect(res.body).toMatchObject({ status: 'disabled', reason: 'caller_auth_unconfigured' });
    });
  });

  describe('caller auth configured, no key stored', () => {
    it('is the OTHER reason, and points at Settings rather than at an env var', async () => {
      app = await boot({ SECRET_KEY: SECRET, CLERK_ISSUER: 'https://clerk.example' });

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      expect(res.body).toMatchObject({
        status: 'disabled',
        reason: 'anthropic_api_key_missing',
        message: expect.stringContaining('Settings'),
      });
    });
  });

  describe('fully configured', () => {
    const CONFIGURED = { SECRET_KEY: SECRET, CLERK_ISSUER: 'https://clerk.example' };

    it('reports ok, unauthenticated and without leaking config', async () => {
      storedKey = 'sk-test';
      app = await boot(CONFIGURED);

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      // Exactly this shape: the probe is public, so the model and the key must not ride along.
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('hands the functional endpoints back to auth — 401, not 503', async () => {
      storedKey = 'sk-test';
      app = await boot(CONFIGURED);

      await asCaller(request(app.getHttpServer()).post('/api/composer/stream'))
        .send({ message: 'hi' })
        .expect(401);
    });

    it('proves the PROCESS with a signed token, never the raw secret on the wire', async () => {
      storedKey = 'sk-test';
      app = await boot(CONFIGURED);

      await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200, { status: 'ok' });

      expect(internalAuth.length).toBeGreaterThan(0);
      for (const token of internalAuth) {
        expect(token).not.toContain(SECRET);
        expect(token.split('.')).toHaveLength(3); // a JWS, not the secret itself
      }
    });

    /** The composer answers about YOU, so a probe with no caller can only be "no key for you". */
    it('reports disabled for a caller-less probe rather than guessing', async () => {
      storedKey = 'sk-test';
      app = await boot(CONFIGURED);

      const res = await request(app.getHttpServer()).get('/api/composer/status').expect(200);
      expect(res.body).toMatchObject({ status: 'disabled', reason: 'anthropic_api_key_missing' });
    });

    /** The whole point of the move: a key set in Settings works without restarting anything. */
    it('flips from disabled to ok when a key is stored, with no restart', async () => {
      app = await boot(CONFIGURED);

      const before = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);
      expect(before.body).toMatchObject({ status: 'disabled', reason: 'anthropic_api_key_missing' });

      storedKey = 'sk-set-just-now';

      await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200, { status: 'ok' });
    });

    it('falls back to disabled — never to a stale key — when the service goes away', async () => {
      storedKey = 'sk-test';
      app = await boot({ ...CONFIGURED, WORKFLOW_SERVICE_URL: 'http://127.0.0.1:1' });

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      expect(res.body).toMatchObject({ status: 'disabled', reason: 'anthropic_api_key_missing' });
    });
  });

  describe('MOCK_AUTH', () => {
    it('counts as configured caller auth without Clerk', async () => {
      storedKey = 'sk-test';
      app = await boot({
        SECRET_KEY: SECRET,
        MOCK_AUTH: 'true',
        WORKFLOW_SERVICE_API_KEY: 'ork_test',
      });

      await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200, { status: 'ok' });
    });
  });

  describe('local sessions (self-host)', () => {
    // Everything a self-host has: the SECRET_KEY the workflow service already signs its
    // sessions with. The Anthropic key comes from that service's store (`storedKey`).
    const SELF_HOST = { SECRET_KEY: SECRET };

    /**
     * /token is guard-protected and answers 404 for a session it does not know,
     * without reaching Anthropic — so 404 means "the guard let this caller
     * through" and 401 means it did not. That is the whole boundary under test.
     */
    // These probe the AUTH boundary, so the enabled gate ahead of it must be satisfied.
    beforeEach(() => {
      storedKey = 'sk-test';
    });

    function callToken(token?: string): request.Test {
      const req = request(app!.getHttpServer()).post('/api/composer/token');
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req.send({ session_id: randomUUID() });
    }

    it('the shared SECRET_KEY plus a stored key enables the composer — no Clerk anywhere', async () => {
      storedKey = 'sk-test';
      app = await boot(SELF_HOST);

      await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200, { status: 'ok' });
    });

    it("sends each visitor's address on behind Sarati's proxy, so the service counts their limits apart", async () => {
      app = await boot({ ...SELF_HOST, TRUST_PROXY_HOPS: '1' });

      for (const visitor of ['203.0.113.1', '2001:db8:a:b::7']) {
        await asCaller(request(app.getHttpServer()).get('/api/composer/status'))
          .set('X-Forwarded-For', visitor)
          .expect(200, { status: 'ok' });
      }
      expect(forwardedFor).toEqual(['203.0.113.1', '2001:db8:a:b::7']);
    });

    it('says a rate-limited caller asked too often — never that they lack a key — and the endpoints answer 429', async () => {
      storedKey = 'sk-test';
      rateLimited = true;
      app = await boot(SELF_HOST);

      const status = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);
      expect(status.body).toEqual({
        status: 'disabled',
        reason: 'rate_limited',
        message: 'Too many requests from your address — try again in a minute.',
        docs: expect.any(String),
      });
      const token = await asCaller(request(app.getHttpServer()).post('/api/composer/token'))
        .send({ session_id: randomUUID() })
        .expect(429);
      expect(token.body).toMatchObject({ reason: 'rate_limited' });
    });

    it('sends on only the entry the trusted proxy added, never one the visitor wrote before it', async () => {
      app = await boot({ ...SELF_HOST, TRUST_PROXY_HOPS: '1' });

      await asCaller(request(app.getHttpServer()).get('/api/composer/status'))
        .set('X-Forwarded-For', '198.51.100.66, 203.0.113.1')
        .expect(200, { status: 'ok' });
      expect(forwardedFor).toEqual(['203.0.113.1']);
    });

    it('trusting no proxy, sends on the connecting address, never one a caller wrote', async () => {
      app = await boot(SELF_HOST);

      await asCaller(request(app.getHttpServer()).get('/api/composer/status'))
        .set('X-Forwarded-For', '198.51.100.66')
        .expect(200, { status: 'ok' });
      expect(forwardedFor).toEqual([expect.stringMatching(/^(::ffff:)?127\.0\.0\.1$/)]);
    });

    it('authenticates a local session token', async () => {
      app = await boot(SELF_HOST);

      await callToken(await localToken()).expect(404);
    });

    it('still refuses an unauthenticated caller', async () => {
      app = await boot(SELF_HOST);

      await callToken().expect(401);
    });

    it('rejects a token signed with a different secret', async () => {
      app = await boot(SELF_HOST);

      const res = await callToken(await localToken({ secret: 'not-the-shared-secret' })).expect(401);
      expect(res.body).toMatchObject({ message: 'Invalid token' });
    });

    it('rejects a foreign issuer even when it is signed with the right secret', async () => {
      app = await boot(SELF_HOST);

      // The core property: holding SECRET_KEY is not enough — a token has
      // to be a local session, so one path can never mint for another.
      await callToken(await localToken({ issuer: 'https://clerk.example' })).expect(401);
    });

    it('rejects a subject-less token rather than admitting an unkeyed caller', async () => {
      app = await boot(SELF_HOST);

      // `sub` is the durable composer-thread key, so a blank one cannot be let in.
      await callToken(await localToken({ sub: '' })).expect(401);
    });

    it('says "expired" for a lapsed session, so the client re-logins instead of hunting a bug', async () => {
      app = await boot(SELF_HOST);

      const res = await callToken(await localToken({ lifetime: -60 })).expect(401);
      expect(res.body).toMatchObject({ message: 'Token expired' });
    });

    it('reports caller auth unconfigured when SECRET_KEY is absent, naming both fixes', async () => {
      storedKey = 'sk-test';
      app = await boot({});

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      expect(res.body.reason).toBe('caller_auth_unconfigured');
      expect(res.body.message).toContain('SECRET_KEY');
      expect(res.body.message).toContain('CLERK_ISSUER');
    });

    it('refuses a session naming a sign-in method it does not know', async () => {
      app = await boot(SELF_HOST);

      await callToken(await localToken({ claims: { method: 'magic-link' } })).expect(401);
    });

    it('LOCAL_AUTH_ENABLED=false opts out even with the secret present', async () => {
      storedKey = 'sk-test';
      app = await boot({ ...SELF_HOST, LOCAL_AUTH_ENABLED: 'false' });

      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);

      expect(res.body).toMatchObject({ status: 'disabled', reason: 'caller_auth_unconfigured' });
    });
  });

  describe('single sign-on sessions (self-host with an identity provider)', () => {
    const ISSUER = 'https://login.example.com/';
    const SSO = { SECRET_KEY: SECRET, OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'sarati' };
    const ssoSession = (idp = ISSUER): Promise<string> => localToken({ claims: { method: 'oidc', idp } });
    const passwordSession = (): Promise<string> => localToken({ claims: { method: 'password' } });

    beforeEach(() => {
      storedKey = 'sk-test';
    });

    function callToken(token?: string): request.Test {
      const req = request(app!.getHttpServer()).post('/api/composer/token');
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req.send({ session_id: randomUUID() });
    }

    it('lets a single sign-on session through, and no password session — passwords default off', async () => {
      app = await boot(SSO);

      await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);
      await callToken(await ssoSession()).expect(404);
      await callToken(await passwordSession()).expect(401);
      await callToken(await localToken()).expect(401);
    });

    it('refuses a single sign-on session minted under another issuer, even a trailing slash apart', async () => {
      app = await boot(SSO);

      await callToken(await ssoSession('https://other.example.com/')).expect(401);
      await callToken(await ssoSession('https://login.example.com')).expect(401);
    });

    it('refuses one signed with another secret', async () => {
      app = await boot(SSO);

      await callToken(
        await localToken({ secret: 'not-the-shared-secret', claims: { method: 'oidc', idp: ISSUER } }),
      ).expect(401);
    });

    it('takes both kinds while LOCAL_AUTH_ENABLED=true keeps passwords beside it', async () => {
      app = await boot({ ...SSO, LOCAL_AUTH_ENABLED: 'true' });

      await callToken(await ssoSession()).expect(404);
      await callToken(await passwordSession()).expect(404);
    });

    it('refuses single sign-on sessions once single sign-on is off, and names the variables when nothing is left', async () => {
      app = await boot({ SECRET_KEY: SECRET, OIDC_ISSUER: ISSUER });
      await callToken(await ssoSession()).expect(401);
      await app.close();

      app = await boot({ SECRET_KEY: SECRET, OIDC_ISSUER: ISSUER, LOCAL_AUTH_ENABLED: 'false' });
      const res = await asCaller(request(app.getHttpServer()).get('/api/composer/status')).expect(200);
      expect(res.body.reason).toBe('caller_auth_unconfigured');
      expect(res.body.message).toContain('OIDC_CLIENT_ID');
    });
  });
});
