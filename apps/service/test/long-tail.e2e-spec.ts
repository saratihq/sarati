import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

describe('M8 long tail (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';

    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    await request(app.getHttpServer()).get('/api/auth/me').expect(200);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  let wfId = '';

  it('seeds a native workflow for the long-tail cases', async () => {
    const deployed = await request(app.getHttpServer())
      .post('/api/deploy')
      .send({
        workflow_json: {
          schema_version: 1,
          name: 'long-tail seed',
          engine: 'orchestr',
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
              id: 'step',
              name: 'Announce',
              node_type: 'text.concat',
              type_version: 1,
              parameters: { texts: ['ok'], separator: '' },
              position: { x: 200, y: 0 },
              metadata: {},
            },
          ],
          edges: [{ id: 'e1', source_node_id: 'trigger', target_node_id: 'step' }],
        },
      })
      .expect(201);
    wfId = deployed.body.workflow_id;
    expect(wfId).toBeTruthy();
  });
  it('idempotency: a repeated mutating request with the same key replays, does not re-run', async () => {
    const idem = `idem-${Date.now()}`;
    const first = await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/branches`)
      .set('Idempotency-Key', idem)
      .send({ name: 'idem-branch' })
      .expect(201);

    // Same key again — replays the stored response (would otherwise 400 "already exists").
    const second = await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/branches`)
      .set('Idempotency-Key', idem)
      .send({ name: 'idem-branch' })
      .expect(201);
    expect(second.body.id).toBe(first.body.id);

    // Only ONE branch was created.
    const branches = await request(app.getHttpServer()).get(`/api/workflows/${wfId}/branches`).expect(200);
    const count = branches.body.branches.filter((b: { name: string }) => b.name === 'idem-branch').length;
    expect(count).toBe(1);
  });

  it('idempotency: reusing a key on a DIFFERENT endpoint is refused, not silently replayed', async () => {
    const idem = `idem-mismatch-${Date.now()}`;
    await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/branches`)
      .set('Idempotency-Key', idem)
      .send({ name: 'idem-mismatch-branch' })
      .expect(201);

    // Same key, different request → 422; replaying the branch response as a commit response would be wrong.
    const mismatch = await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/commit`)
      .set('Idempotency-Key', idem)
      .send({ workflow_json: { name: 'x', nodes: [], connections: {} } })
      .expect(422);
    expect(mismatch.body.detail).toContain('already used for');
  });

  it('node icons: DB cache wins; known app serves a self-hosted inline SVG (no fetch); control + unknown → null', async () => {
    // Seed the DB-cache tier with an app-action icon (the native icon source).
    await db.query(
      `INSERT INTO node_icons (node_type, svg, source, created_at)
         VALUES ($1, $2, 'app', now())
       ON CONFLICT (node_type) DO UPDATE SET svg = EXCLUDED.svg`,
      ['acme.send_channel_message', '<svg data-test="cached-logo"></svg>'],
    );

    const res = await request(app.getHttpServer())
      .post('/api/node-icons/batch')
      .send({
        node_types: [
          'acme.send_channel_message', // cached tier
          'stripe.create_charge', // uncached known app → inline SVG from the self-hosted map
          'orchestr:if', // control node
          'zzznotanapp.doThing', // unknown app slug
        ],
      })
      .expect(201);

    // The cached icon is served from the DB cache tier…
    expect(res.body.icons['acme.send_channel_message']).toBe('<svg data-test="cached-logo"></svg>');
    // …a known app resolves to a self-hosted inline brand SVG, served with no outbound fetch…
    const stripe = res.body.icons['stripe.create_charge'];
    expect(typeof stripe).toBe('string');
    expect(stripe.startsWith('<svg')).toBe(true);
    expect(stripe).toContain('<path');
    // No vendor CDN residue — the icon is self-hosted, not a fetched logo URL.
    expect(stripe).not.toMatch(/activepieces|cdn\.activepieces/i);
    // …a native control node has no app logo → null (the static-route fallback is gone)…
    expect(res.body.icons['orchestr:if']).toBeNull();
    // …and an unknown app slug resolves to null without erroring.
    expect(res.body.icons['zzznotanapp.doThing']).toBeNull();
  });
});
