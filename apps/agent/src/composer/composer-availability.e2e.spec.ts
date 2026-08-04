import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';

import { AppModule } from '../app.module';
import { LOCAL_ISSUER } from './composer-auth.guard';

/**
 * The self-host capability contract, exercised over real HTTP against a real
 * boot. Two regressions it guards, both of which made the composer unreachable
 * on a self-host: a crash-loop without ANTHROPIC_API_KEY, and — once that was
 * fixed — a guard that only spoke Clerk, so every local-session caller 401'd.
 */

const BASE_ENV = {
  ENVIRONMENT: 'development',
  PORT: '8010',
  WORKFLOW_SERVICE_URL: 'http://localhost:8001',
};

/** Stands in for the value entrypoint.sh generates onto the shared data volume. */
const SECRET = 'shared-secret-off-the-data-volume';

/** Mirrors workflow-service's mintSession — the token a local login hands the client. */
async function localToken(
  over: { secret?: string; sub?: string; issuer?: string; lifetime?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(over.issuer ?? LOCAL_ISSUER)
    .setSubject(over.sub ?? 'user_selfhost_1')
    .setIssuedAt(now)
    .setExpirationTime(now + (over.lifetime ?? 3600))
    .sign(new TextEncoder().encode(over.secret ?? SECRET));
}

async function boot(overrides: Record<string, string>): Promise<INestApplication> {
  process.env = { PATH: process.env.PATH, ...BASE_ENV, ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('composer availability', () => {
  const realEnv = process.env;
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    process.env = realEnv;
  });

  describe('no credentials at all', () => {
    it('boots instead of throwing, and reports the Anthropic key first', async () => {
      app = await boot({});

      const res = await request(app.getHttpServer()).get('/api/composer/status').expect(200);

      expect(res.body).toEqual({
        status: 'disabled',
        reason: 'anthropic_api_key_missing',
        message: expect.stringContaining('ANTHROPIC_API_KEY'),
        docs: expect.any(String),
      });
    });

    it('503s the functional endpoints with the reason, ahead of auth', async () => {
      app = await boot({});

      // No Authorization header: the 401 would be the misleading answer here.
      const res = await request(app.getHttpServer())
        .post('/api/composer/stream')
        .send({ message: 'build me a workflow' })
        .expect(503);

      expect(res.body).toMatchObject({ reason: 'anthropic_api_key_missing' });
    });

    it('503s a malformed body too — the gate is not behind validation', async () => {
      app = await boot({});

      await request(app.getHttpServer()).post('/api/composer/stream').send({}).expect(503);
    });

    it('keeps /api/health answering — the container HEALTHCHECK depends on it', async () => {
      app = await boot({});

      await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
    });
  });

  describe('Anthropic key but no caller auth', () => {
    it('stays disabled rather than serving an unauthenticated composer', async () => {
      app = await boot({ ANTHROPIC_API_KEY: 'sk-test' });

      const res = await request(app.getHttpServer()).get('/api/composer/status').expect(200);

      expect(res.body).toMatchObject({
        status: 'disabled',
        reason: 'caller_auth_unconfigured',
        message: expect.stringContaining('CLERK_ISSUER'),
      });
      await request(app.getHttpServer()).post('/api/composer/stream').send({ message: 'hi' }).expect(503);
    });
  });

  describe('fully configured', () => {
    it('reports ok, unauthenticated and without leaking config', async () => {
      app = await boot({ ANTHROPIC_API_KEY: 'sk-test', CLERK_ISSUER: 'https://clerk.example' });

      const res = await request(app.getHttpServer()).get('/api/composer/status').expect(200);

      // Exactly this shape: the probe is public, so the model and the key must not ride along.
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('hands the functional endpoints back to auth — 401, not 503', async () => {
      app = await boot({ ANTHROPIC_API_KEY: 'sk-test', CLERK_ISSUER: 'https://clerk.example' });

      await request(app.getHttpServer()).post('/api/composer/stream').send({ message: 'hi' }).expect(401);
    });
  });

  describe('MOCK_AUTH', () => {
    it('counts as configured caller auth without Clerk', async () => {
      app = await boot({
        ANTHROPIC_API_KEY: 'sk-test',
        MOCK_AUTH: 'true',
        WORKFLOW_SERVICE_API_KEY: 'ork_test',
      });

      await request(app.getHttpServer()).get('/api/composer/status').expect(200, { status: 'ok' });
    });
  });

  describe('local sessions (self-host, ADR 0054)', () => {
    // Everything a self-host has: the operator's Anthropic key, and the
    // SECRET_KEY the workflow service already signs its sessions with.
    const SELF_HOST = { ANTHROPIC_API_KEY: 'sk-test', SECRET_KEY: SECRET };

    /**
     * /token is guard-protected and answers 404 for a session it does not know,
     * without reaching Anthropic — so 404 means "the guard let this caller
     * through" and 401 means it did not. That is the whole boundary under test.
     */
    function callToken(token?: string): request.Test {
      const req = request(app!.getHttpServer()).post('/api/composer/token');
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req.send({ session_id: randomUUID() });
    }

    it('the shared SECRET_KEY alone enables the composer — no Clerk anywhere', async () => {
      app = await boot(SELF_HOST);

      await request(app.getHttpServer()).get('/api/composer/status').expect(200, { status: 'ok' });
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

      // The ADR's core property: holding SECRET_KEY is not enough — a token has
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
      app = await boot({ ANTHROPIC_API_KEY: 'sk-test' });

      const res = await request(app.getHttpServer()).get('/api/composer/status').expect(200);

      expect(res.body.reason).toBe('caller_auth_unconfigured');
      expect(res.body.message).toContain('SECRET_KEY');
      expect(res.body.message).toContain('CLERK_ISSUER');
    });

    it('LOCAL_AUTH_ENABLED=false opts out even with the secret present', async () => {
      app = await boot({ ...SELF_HOST, LOCAL_AUTH_ENABLED: 'false' });

      const res = await request(app.getHttpServer()).get('/api/composer/status').expect(200);

      expect(res.body).toMatchObject({ status: 'disabled', reason: 'caller_auth_unconfigured' });
    });
  });
});
