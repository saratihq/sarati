import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** BYO-auth (A1): with Composio unconfigured the connect surface is BYO-only and the secret never comes back. */
describe('BYO connection (A1, e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.COMPOSIO_API_KEY = ''; // managed rail off → BYO-only

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('reports managed_available=false when Composio is not configured (BYO-only layout)', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections/capabilities').expect(200);
    expect(res.body).toEqual({ managed_available: false });
  });

  it('stores a pasted (BYO) credential as a token connection; the secret never returns', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/connections')
      .send({ provider: 'slack', credential: { value: 'xoxb-secret-123' }, display_name: 'My Slack' })
      .expect(201);
    expect(create.body.auth_type).toBe('token');
    expect(create.body.provider).toBe('slack');
    expect(JSON.stringify(create.body)).not.toContain('xoxb-secret-123'); // no secret leak

    const list = await request(app.getHttpServer()).get('/api/connections').expect(200);
    const rows = (list.body.connections ?? list.body) as Array<Record<string, unknown>>;
    expect(rows.some((c) => c.id === create.body.id && c.provider === 'slack')).toBe(true);
  });
});
