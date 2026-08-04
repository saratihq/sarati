import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
// A valid Fernet key so credentials are actually encrypted at rest in this run.
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Store an encrypted credential, never expose the secret, resolve it back decrypted. */
describe('connections endpoint (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let connectionId = '';
  const SECRET = 'xoxb-super-secret-token';

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

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

  it('creates a token connection and never returns the secret', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/connections')
      .send({
        provider: 'slack',
        credential: { token: SECRET },
        display_name: 'My Slack',
      })
      .expect(201);
    connectionId = res.body.id;
    expect(res.body.provider).toBe('slack');
    expect(res.body.auth_type).toBe('token');
    expect(res.body.display_name).toBe('My Slack');
    expect(res.body.status).toBe('active'); // non-managed rows are always usable
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('stores the credential encrypted but resolves it back decrypted', async () => {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const cred = await app.get(ConnectionsService).getCredential(me.body.user.id, connectionId);
    expect(cred).toEqual({ token: SECRET });
  });

  it('lists connections without exposing secrets', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections').expect(200);
    expect(res.body.some((c: { id: string }) => c.id === connectionId)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('lists health fields: never-checked rows have null reason and last-checked', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections').expect(200);
    const row = res.body.find((c: { id: string }) => c.id === connectionId);
    expect(row).toMatchObject({ status: 'active', status_reason: null, last_checked_at: null });
  });

  it('test-probes an API-key connection: shape-only, honest about the depth', async () => {
    const res = await request(app.getHttpServer()).post(`/api/connections/${connectionId}/test`).expect(200);
    // API keys have no uniform provider no-op, so the probe verifies decryptability only — and says so.
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('active');
    expect(res.body.detail).toContain('verified with the provider when a step runs');

    const list = await request(app.getHttpServer()).get('/api/connections').expect(200);
    const row = list.body.find((c: { id: string }) => c.id === connectionId);
    expect(row.status_reason).toBeNull();
    expect(typeof row.last_checked_at).toBe('string'); // the probe stamped it
  });

  it('404s the test probe for a connection that does not exist', async () => {
    await request(app.getHttpServer())
      .post('/api/connections/00000000-0000-0000-0000-000000000000/test')
      .expect(404);
  });

  it('renames a connection — and an empty name clears back to the provider label', async () => {
    const renamed = await request(app.getHttpServer())
      .patch(`/api/connections/${connectionId}`)
      .send({ display_name: 'Work Slack (renamed)' })
      .expect(200);
    expect(renamed.body.display_name).toBe('Work Slack (renamed)');

    const listed = await request(app.getHttpServer()).get('/api/connections').expect(200);
    const row = (listed.body as Array<{ id: string; display_name: string | null }>).find(
      (c) => c.id === connectionId,
    );
    expect(row?.display_name).toBe('Work Slack (renamed)');

    const cleared = await request(app.getHttpServer())
      .patch(`/api/connections/${connectionId}`)
      .send({ display_name: '   ' })
      .expect(200);
    expect(cleared.body.display_name).toBeNull();

    await request(app.getHttpServer())
      .patch('/api/connections/00000000-0000-0000-0000-000000000000')
      .send({ display_name: 'ghost' })
      .expect(404);
  });

  it('deletes a connection (and 404s the second time)', async () => {
    await request(app.getHttpServer()).delete(`/api/connections/${connectionId}`).expect(200);
    await request(app.getHttpServer()).delete(`/api/connections/${connectionId}`).expect(404);
  });

  // Guards the README's "never returned over the API" promise across EVERY connection-returning route.
  // Asserted on the serialised body, not a named field, so a NEW field carrying the secret fails too.
  it('never exposes a stored credential over the API', async () => {
    const server = app.getHttpServer();
    const canary = 'canary-credential-must-never-be-returned';
    const created = await request(server)
      .post('/api/connections')
      .send({ provider: 'stripe', credential: { api_key: canary }, display_name: 'Canary' })
      .expect(201);
    const id = created.body.id as string;

    const me = await request(server).get('/api/auth/me').expect(200);
    // Non-vacuous: the canary really is stored under this id, so its absence below is redaction, not a no-op.
    expect(await app.get(ConnectionsService).getCredential(me.body.user.id, id)).toEqual({
      api_key: canary,
    });

    const responses: Array<[route: string, body: unknown]> = [
      ['POST /api/connections', created.body],
      ['GET /api/connections', (await request(server).get('/api/connections').expect(200)).body],
      [
        'GET /api/connections/:id/references',
        (await request(server).get(`/api/connections/${id}/references`).expect(200)).body,
      ],
      [
        'PATCH /api/connections/:id',
        (
          await request(server)
            .patch(`/api/connections/${id}`)
            .send({ display_name: 'Canary renamed' })
            .expect(200)
        ).body,
      ],
      [
        'POST /api/connections/:id/test',
        (await request(server).post(`/api/connections/${id}/test`).expect(200)).body,
      ],
    ];

    for (const [route, body] of responses) {
      expect(`${route} -> ${JSON.stringify(body)}`).not.toContain(canary);
    }
  });
});
