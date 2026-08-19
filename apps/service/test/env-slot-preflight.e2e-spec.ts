import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/**
 * A version whose steps need connections: a Slack step that names one, and an agent that resolves
 * its model provider's slot with or without one.
 */
function irDoc(): Record<string, unknown> {
  const node = (
    id: string,
    nodeType: string,
    parameters: Record<string, unknown>,
    x: number,
  ): Record<string, unknown> => ({
    id,
    name: id,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x, y: 0 },
    metadata: {},
  });
  return {
    version: '1.0',
    name: 'needs connections',
    description: '',
    nodes: [
      node('trigger', 'orchestr:webhook', {}, 0),
      node(
        'agent',
        'orchestr:agent',
        {
          model: { provider: 'claude', model: 'claude-opus-4-8' },
          system_prompt: 'Trie',
          max_steps: 2,
          input: '{{trigger.text}}',
        },
        200,
      ),
      node(
        'post',
        'slack.send_channel_message',
        { connectionId: randomUUID(), channel: 'C1', text: 'x' },
        400,
      ),
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'agent',
        target_port: 0,
        port_type: 'main',
      },
      {
        id: 'e2',
        source_node_id: 'agent',
        source_port: 0,
        target_node_id: 'post',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/**
 * A promote into an environment that cannot run the version is refused UP FRONT. Without this the
 * promote succeeds and the workflow reports green until a run happens to reach one of those steps —
 * a schedule whose filter never matches can sit "completed" for days while being unrunnable.
 */
describe('env slot preflight (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const userId = randomUUID();
  const key = 'ork_e2e_slotpre_aaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const as = (r: request.Test): request.Test =>
    r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', orgId);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  let orgId = '';
  let wfId = '';
  let versionId = '';
  let stagingId = '';
  let slackConnId = '';
  let claudeConnId = '';

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'slot@e2e.local', 'Slot', now(), now())`,
      [userId],
    );
    const personal = randomUUID();
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Personal', true, now(), now())`,
      [personal],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [personal, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'k', $2, $3, now())`,
      [userId, hash(key), key.slice(0, 12)],
    );

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

    const connections = app.get(ConnectionsService);
    slackConnId = (
      await connections.createToken(userId, {
        provider: 'slack',
        credential: { api_key: 'xoxb-e2e' },
        displayName: 'Slack',
      })
    ).id;
    claudeConnId = (
      await connections.createToken(userId, {
        provider: 'claude',
        credential: { api_key: 'sk-e2e' },
        displayName: 'Claude',
      })
    ).id;

    const org = await http()
      .post('/api/orgs')
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'Acme' })
      .expect(201);
    orgId = org.body.id as string;

    // Creating is NOT gated — only asserting "run this here" is.
    const deployed = await as(http().post('/api/deploy').send({ workflow_json: irDoc() })).expect(201);
    wfId = deployed.body.workflow_id as string;
    const staging = await as(http().post('/api/environments').send({ name: 'staging' })).expect(201);
    stagingId = staging.body.id as string;
    const versions = await as(http().get(`/api/workflows/${wfId}/versions`)).expect(200);
    versionId = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('refuses the promote and NAMES every app the environment cannot supply', async () => {
    const refused = await as(
      http().post(`/api/workflows/${wfId}/promote`).send({ environment: 'staging', version_id: versionId }),
    ).expect(428);
    const detail = String(refused.body.detail);
    expect(detail).toContain('claude');
    expect(detail).toContain('slack');
    expect(detail).toContain('staging');
  });

  it('creating was never blocked — the version exists and only staging was refused', async () => {
    const staging = await db.query(
      `SELECT count(*)::int AS n FROM workflow_env_pointers WHERE workflow_id = $1 AND environment = 'staging'`,
      [wfId],
    );
    expect(staging.rows[0].n).toBe(0);
    expect(versionId).not.toBe('');
  });

  it('still refuses when only ONE of the two slots is filled', async () => {
    await as(
      http().put(`/api/environments/${stagingId}/slots/slack`).send({ connection_id: slackConnId }),
    ).expect(200);

    const refused = await as(
      http().post(`/api/workflows/${wfId}/promote`).send({ environment: 'staging', version_id: versionId }),
    ).expect(428);
    expect(String(refused.body.detail)).toContain('claude');
    expect(String(refused.body.detail)).not.toContain('slack');
  });

  it('promotes once every slot the version needs is filled', async () => {
    await as(
      http().put(`/api/environments/${stagingId}/slots/claude`).send({ connection_id: claudeConnId }),
    ).expect(200);
    const promoted = await as(
      http().post(`/api/workflows/${wfId}/promote`).send({ environment: 'staging', version_id: versionId }),
    ).expect(201);
    expect(promoted.body.status).toBe('promoted');
  });
});
