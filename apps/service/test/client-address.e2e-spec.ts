import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const LOGIN_LIMIT = 5;

/** The sign-in limit counts per client address, and a client cannot choose that address by sending X-Forwarded-For. */
describe('client address behind proxies (e2e, isolated DB)', () => {
  /** Boot an app with the given proxy settings, on its own database and its own throttle counters. */
  function bootWith(env: Record<string, string>): { app: () => INestApplication; warnings: () => string[] } {
    let app: INestApplication;
    let warn: jest.SpyInstance;
    beforeAll(async () => {
      process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
      process.env.PGBOSS_ENABLED = 'false';
      process.env.MOCK_AUTH = 'false';
      process.env.CLERK_ISSUER = '';
      Object.assign(process.env, env);
      warn = jest.spyOn(Logger.prototype, 'warn');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
      configureApp(app);
      await app.init();
      await listenOnLoopback(app);
    }, 30_000);
    afterAll(async () => {
      warn.mockRestore();
      await app.close();
      process.env.DATABASE_URL = ADMIN_URL;
      for (const name of Object.keys(env)) delete process.env[name];
    });
    return { app: () => app, warnings: () => warn.mock.calls.map((call) => String(call[0])) };
  }

  /** The statuses of `count` failed sign-ins, each sent with the X-Forwarded-For that `forwardedFor(i)` gives. */
  async function signIns(
    app: INestApplication,
    count: number,
    forwardedFor: (i: number) => string | undefined,
  ): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 1; i <= count; i++) {
      const req = request(app.getHttpServer()).post('/api/auth/local/login');
      const header = forwardedFor(i);
      if (header !== undefined) void req.set('X-Forwarded-For', header);
      statuses.push((await req.send({ email: 'nobody@example.test', password: 'wrong-password' })).status);
    }
    return statuses;
  }

  const throttledAfterLimit = [...Array<number>(LOGIN_LIMIT).fill(401), 429, 429];

  describe('nothing in front (TRUST_PROXY_HOPS unset)', () => {
    const { app } = bootWith({});

    it('ignores X-Forwarded-For: a rotating spoofed address is still throttled', async () => {
      expect(await signIns(app(), LOGIN_LIMIT + 2, (i) => `198.51.100.${i}`)).toEqual(throttledAfterLimit);
    });
  });

  describe("Sarati's own proxy in front (TRUST_PROXY_HOPS=1)", () => {
    const { app } = bootWith({ TRUST_PROXY_HOPS: '1' });

    it('counts each client the proxy names on its own', async () => {
      expect(await signIns(app(), LOGIN_LIMIT + 2, () => '203.0.113.10')).toEqual(throttledAfterLimit);
      expect(await signIns(app(), 1, () => '203.0.113.11')).toEqual([401]);
    });

    it('reads only the entry the proxy added, so a spoofed one before it changes nothing', async () => {
      expect(await signIns(app(), LOGIN_LIMIT + 2, (i) => `198.51.100.${i}, 203.0.113.12`)).toEqual(
        throttledAfterLimit,
      );
    });

    it('counts an IPv6 client by its /64, so rotating through it is still throttled', async () => {
      expect(await signIns(app(), LOGIN_LIMIT + 2, (i) => `2001:db8:a:b::${i}`)).toEqual(throttledAfterLimit);
      expect(await signIns(app(), 1, () => '2001:db8:a:c::1')).toEqual([401]);
    });

    it('counts an IPv4-mapped address as the IPv4 client it carries', async () => {
      expect(await signIns(app(), LOGIN_LIMIT, () => '203.0.113.13')).toEqual(Array(LOGIN_LIMIT).fill(401));
      expect(await signIns(app(), 1, () => '::ffff:203.0.113.13')).toEqual([429]);
    });
  });

  describe('another proxy in front of it (TRUST_PROXY_HOPS=2)', () => {
    const { app } = bootWith({ TRUST_PROXY_HOPS: '2' });

    it('uses the real client address behind both hops, whatever the client sent', async () => {
      expect(
        await signIns(app(), LOGIN_LIMIT + 2, (i) => `198.51.100.${i}, 203.0.113.20, 192.0.2.1`),
      ).toEqual(throttledAfterLimit);
      expect(await signIns(app(), 1, () => '198.51.100.1, 203.0.113.21, 192.0.2.1')).toEqual([401]);
    });
  });

  describe('the replaced TRUST_PROXY_HEADERS=true', () => {
    const { app, warnings } = bootWith({ TRUST_PROXY_HEADERS: 'true' });

    it('trusts one hop, not the left-most entry a client writes', async () => {
      expect(await signIns(app(), LOGIN_LIMIT + 2, (i) => `198.51.100.${i}, 203.0.113.30`)).toEqual(
        throttledAfterLimit,
      );
    });

    it('says at boot what it is read as, without telling a bundled stack to set anything', () => {
      expect(warnings()).toContain(
        "TRUST_PROXY_HEADERS=true is read as TRUST_PROXY_HOPS=1 — remove it. Sarati's stack files set TRUST_PROXY_HOPS themselves, so a stack missing it runs an old stack file: re-run the installer. Set TRUST_PROXY_HOPS=1 yourself only for an image run behind a proxy of your own.",
      );
    });
  });

  describe('the replaced TRUST_PROXY_HEADERS=false, as the old docs shipped it', () => {
    const { app, warnings } = bootWith({ TRUST_PROXY_HEADERS: 'false' });

    it('changes nothing and says nothing', async () => {
      expect(await signIns(app(), LOGIN_LIMIT + 2, (i) => `198.51.100.${i}`)).toEqual(throttledAfterLimit);
      expect(warnings().filter((w) => w.includes('TRUST_PROXY'))).toEqual([]);
    });
  });

  describe('TRUST_PROXY_HOPS=true, the old flag renamed', () => {
    const { app, warnings } = bootWith({ TRUST_PROXY_HOPS: 'true' });

    it('boots trusting one hop, and says to write the number', async () => {
      expect(await signIns(app(), 1, () => '203.0.113.40')).toEqual([401]);
      expect(warnings()).toContain(
        'TRUST_PROXY_HOPS counts proxy hops — "true" is read as 1; write the number',
      );
    });
  });
});
