import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Sample plumbing: GET /api/runs/samples, plus the catch inbox — mint (auth) → intake (public) → poll (auth). */
describe('run samples + catch inbox (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;

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

  it('samples: latest completed run outputs, keyed trigger + step id', async () => {
    const irDoc = {
      version: '1',
      name: 'samples probe',
      description: '',
      nodes: [
        {
          id: 'trigger',
          name: 'Trigger',
          node_type: 'orchestr:trigger',
          type_version: 1,
          parameters: {},
          position: { x: 0, y: 0 },
          metadata: {},
        },
        {
          id: 'announce',
          name: 'Announce',
          node_type: 'text.concat',
          type_version: 1,
          parameters: { texts: ['New signup: ', '{{trigger.email}}'], separator: '' },
          position: { x: 300, y: 0 },
          metadata: {},
        },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'announce' }],
      settings: {},
      metadata: { engine: 'orchestr' },
    };
    const dep = await request(app.getHttpServer())
      .post('/api/deploy')
      .send({ workflow_json: irDoc })
      .expect(201);
    const wfId = dep.body.workflow_id as string;

    // No run yet — the picker gets an honest null, not an empty invention.
    const empty = await request(app.getHttpServer()).get(`/api/runs/samples?workflow_id=${wfId}`).expect(200);
    expect(empty.body.sample).toBeNull();

    await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: irDoc, workflow_id: wfId, trigger_payload: { email: 'sara@acme.com' } })
      .expect(201);

    const res = await request(app.getHttpServer()).get(`/api/runs/samples?workflow_id=${wfId}`).expect(200);
    const outputs = res.body.sample.outputs as Record<string, unknown>;
    expect(outputs.trigger).toEqual({ email: 'sara@acme.com' });
    expect(outputs.announce).toBe('New signup: sara@acme.com');
    expect(res.body.sample.run_id).toBeDefined();

    await request(app.getHttpServer()).get('/api/runs/samples').expect(400); // workflow_id required
    await request(app.getHttpServer()).delete(`/api/workflows/${wfId}`).expect(200);
  });

  it('catch inbox: mint → public intake → poll; unknown and expired ids 404', async () => {
    const minted = await request(app.getHttpServer()).post('/api/catch').expect(201);
    const catchId = minted.body.catch_id as string;
    expect(minted.body.path).toBe(`/api/hooks/catch/${catchId}`);

    // Nothing yet.
    const pending = await request(app.getHttpServer()).get(`/api/catch/${catchId}`).expect(200);
    expect(pending.body).toEqual({ received: false, payload: null });

    // Public intake — no auth header at all.
    await request(app.getHttpServer())
      .post(`/api/hooks/catch/${catchId}`)
      .send({ email: 'sara@acme.com', name: 'Sara' })
      .expect(201);

    const got = await request(app.getHttpServer()).get(`/api/catch/${catchId}`).expect(200);
    expect(got.body).toEqual({ received: true, payload: { email: 'sara@acme.com', name: 'Sara' } });

    // Unknown ids: capability-token model — 404, never enumeration.
    await request(app.getHttpServer())
      .post('/api/hooks/catch/00000000-0000-4000-8000-000000000000')
      .send({ x: 1 })
      .expect(404);
    await request(app.getHttpServer()).get('/api/catch/00000000-0000-4000-8000-000000000000').expect(404);
    // Garbage id shape refused before the store is touched.
    await request(app.getHttpServer()).post('/api/hooks/catch/not-a-uuid').send({}).expect(404);
  });
});
