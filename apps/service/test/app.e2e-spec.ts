import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';
import { TestSupportModule } from './support/test-support.module';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

describe('app frame (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Its own database like every other suite: reading DATABASE_URL directly made the result depend
    // on whatever the shell happened to point at, and an unset one silently hit a stale database.
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000'; // global bucket out of the way; per-route limit tested below
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TestSupportModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('GET /api/health — liveness parity', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/ready — DB gates readiness', async () => {
    const res = await request(app.getHttpServer()).get('/api/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toEqual({
      status: expect.stringMatching(/^(ready|degraded)$/) as string,
      database: expect.any(Boolean) as boolean,
    });
    if (res.status === 200) expect(res.body.database).toBe(true);
  });

  it('echoes an incoming X-Request-ID and generates one otherwise', async () => {
    const echoed = await request(app.getHttpServer()).get('/api/health').set('X-Request-ID', 'my-id-123');
    expect(echoed.headers['x-request-id']).toBe('my-id-123');

    const generated = await request(app.getHttpServer()).get('/api/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f]{12}$/);
  });

  it('500 contract: {detail: "Internal server error (ref …)", error_id}', async () => {
    const res = await request(app.getHttpServer()).get('/api/_test/boom').expect(500);
    expect(res.body.error_id).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.detail).toBe(`Internal server error (ref ${res.body.error_id})`);
  });

  it('DomainError → 400 with the message as detail', async () => {
    const res = await request(app.getHttpServer()).get('/api/_test/domain-error').expect(400);
    expect(res.body.detail).toBe('nope');
  });

  it('unmatched route → clean 404 {detail: "Not Found"} (no leaked Nest body)', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist').expect(404);
    expect(res.body).toEqual({ detail: 'Not Found' });
  });

  it('validation errors → detail as array of {msg} (FastAPI shape)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_test/validated')
      .send({ name: 42 })
      .expect(400);
    expect(Array.isArray(res.body.detail)).toBe(true);
    const detail = res.body.detail as Array<{ msg: string }>;
    expect(detail[0]?.msg).toMatch(/name/);
  });

  it('413 contract on oversized native bodies', async () => {
    const big = { blob: 'x'.repeat(2_200_000) };
    const res = await request(app.getHttpServer()).post('/api/_test/echo').send(big).expect(413);
    expect(res.body).toEqual({ detail: 'Request body too large' });
  });

  it('429 contract with the parity message', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/_test/limited').expect(200);
    await request(server).get('/api/_test/limited').expect(200);
    const res = await request(server).get('/api/_test/limited').expect(429);
    expect(res.body.detail).toBe('Rate limit exceeded. Please try again later.');
  });
});
