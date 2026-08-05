import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
} from '../src/providers/managed-integration-provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/** A canvas-node polling workflow (ADR 0018) — the kind whose activation records poll health. */
function pollingDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'health target',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When new mail arrives',
        node_type: 'gmail.gmail_new_email_received',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['polled: ', '{{trigger.title}}'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-announce',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** A failing poll must land `last_error` + `last_polled_at` on the activation row and surface on the API. */
describe('trigger activation health (e2e, mocked provider)', () => {
  let app: INestApplication;
  let db: Client;
  let provider: ManagedIntegrationProvider;
  let pollSpy: jest.SpyInstance;

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_trighealth_aaaaaaaaaaaaaaaaaa';

  const userB = randomUUID();
  const personalB = randomUUID();
  const keyB = 'ork_e2e_trighealth_bbbbbbbbbbbbbbbbbb';

  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const asB = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyB}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  const POLL_ERROR = 'Gmail poll failed (503)';

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    for (const [userId, personalOrgId, email, key] of [
      [userA, personalA, 'health-owner@e2e.local', keyA],
      [userB, personalB, 'health-other@e2e.local', keyB],
    ] as const) {
      await db.query(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, 'Health', now(), now())`,
        [userId, email],
      );
      await db.query(
        `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Health Org', true, now(), now())`,
        [personalOrgId],
      );
      await db.query(
        `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
        [personalOrgId, userId],
      );
      await db.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
        [userId, hash(key), key.slice(0, 12)],
      );
    }

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    // Mock ONLY the trigger lifecycle — the reconciler still materializes the activation for real.
    provider = app.get<ManagedIntegrationProvider>(MANAGED_INTEGRATION_PROVIDER);
    jest.spyOn(provider, 'enableTrigger').mockResolvedValue(undefined);
    jest.spyOn(provider, 'disableTrigger').mockResolvedValue(undefined);
    pollSpy = jest.spyOn(provider, 'pollTrigger').mockResolvedValue([]);

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;

    // The env slot must be present, or a missing-slot error would mask the poll failure.
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: pollingDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;

    const envRow = await db.query(
      `SELECT id FROM environments WHERE org_id = $1 AND lower(name) = 'production'`,
      [orgId],
    );
    const prodEnvId = envRow.rows[0].id as string;
    const connId = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
       VALUES ($1, $2, 'gmail', 'managed', 'enc', now(), 'active', $3)`,
      [connId, userA, orgId],
    );
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'gmail', $2)`,
      [prodEnvId, connId],
    );

    await app.get(TriggerReconcilerService).reconcile(wfId);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('a FAILING poll lands last_error + last_polled_at, and the endpoint surfaces them', async () => {
    // One poll turn that throws — the activation catch records it on the row.
    pollSpy.mockRejectedValueOnce(new Error(POLL_ERROR));
    await app.get(TriggersService).runActivationPollCycle();

    const res = await asA(http().get(`/api/triggers/activations?workflow_id=${wfId}`)).expect(200);
    const activations = res.body.activations as Array<Record<string, unknown>>;
    expect(activations).toHaveLength(1);

    const a = activations[0]!;
    expect(a.trigger_type).toBe('gmail.gmail_new_email_received');
    expect(a.kind).toBe('polling');
    expect(a.environment).toBe('production');
    expect(a.active).toBe(true);
    expect(a.status).toBe('error');
    expect(a.last_error).toContain('Gmail poll failed');
    expect(typeof a.last_polled_at).toBe('string');
    expect(Number.isNaN(Date.parse(a.last_polled_at as string))).toBe(false);
  });

  it('a non-owner is refused — authz mirrors every workflow-scoped read', async () => {
    await asB(http().get(`/api/triggers/activations?workflow_id=${wfId}`)).expect(404);
  });

  it('an unknown workflow is 404 and a missing workflow_id is 400', async () => {
    await asA(http().get(`/api/triggers/activations?workflow_id=${randomUUID()}`)).expect(404);
    await asA(http().get('/api/triggers/activations')).expect(400);
  });
});
