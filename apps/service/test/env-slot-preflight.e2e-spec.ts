import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { insertPersonalOrgs } from './support/personal-org';
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
    await insertPersonalOrgs(db, { id: personal, userId: userId, name: 'Personal' });
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
    const envs = await as(http().get('/api/environments')).expect(200);
    stagingId = (envs.body.environments as Array<{ id: string; name: string }>).find(
      (e) => e.name === 'staging',
    )!.id;
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
    expect(refused.body.detail).toBe(
      'staging has no claude or slack account assigned, so "agent" and "post" can\'t run there — assign them under Integrations → Environments before promoting here',
    );
    expect(refused.body.apps).toEqual(['claude', 'slack']);
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
    expect(refused.body.detail).toBe(
      'staging has no claude account assigned, so "agent" can\'t run there — assign one under Integrations → Environments before promoting here',
    );
  });

  // A workflow whose one step emails as its account, chosen or not.
  const deployEmailing = async (): Promise<{ wf: string; v1: string }> => {
    const doc = irDoc();
    const emailing = {
      ...doc,
      name: 'emails a digest',
      nodes: [
        (doc.nodes as unknown[])[0],
        {
          id: 'mail',
          name: 'Email me the report',
          node_type: 'gmail.send_email',
          type_version: 1,
          parameters: { to: '{{$account.email}}', subject: 'Digest', body: 'x' },
          position: { x: 200, y: 0 },
          metadata: {},
        },
      ],
      edges: [{ ...(doc.edges as Array<Record<string, unknown>>)[0], target_node_id: 'mail' }],
    };
    const deployed = await as(http().post('/api/deploy').send({ workflow_json: emailing })).expect(201);
    const wf = deployed.body.workflow_id as string;
    const versions = await as(http().get(`/api/workflows/${wf}/versions`)).expect(200);
    return { wf, v1: (versions.body.versions as Array<{ id: string }>)[0]!.id };
  };

  it('names a step that chooses no account too, and a slot whose account is not active — a run there takes the slot either way', async () => {
    const { wf, v1 } = await deployEmailing();

    const refused = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(428);
    expect(refused.body.detail).toBe(
      'staging has no gmail account assigned, so "Email me the report" can\'t run there — assign one under Integrations → Environments before promoting here',
    );
    expect(refused.body.code).toBe('environment_slots_empty');

    const gmailConn = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, status) VALUES ($1, $2, 'gmail', 'token', 'x', 'expired')`,
      [gmailConn, userId],
    );
    await as(
      http().put(`/api/environments/${stagingId}/slots/gmail`).send({ connection_id: gmailConn }),
    ).expect(200);
    const inactive = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(428);
    expect(inactive.body.detail).toBe(
      "staging's gmail account isn't active, so \"Email me the report\" can't run there — its owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments before promoting here",
    );
    expect(inactive.body.code).toBe('environment_slots_inactive');

    await db.query(`UPDATE connections SET status = 'active' WHERE id = $1`, [gmailConn]);
    const promoted = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(201);
    expect(promoted.body.status).toBe('promoted');
  });

  it("refuses a slot holding another app's account, written before slots checked the app, naming the step", async () => {
    const { wf, v1 } = await deployEmailing();
    await db.query(
      `UPDATE environment_connections SET connection_id = $2 WHERE environment_id = $1 AND app = 'gmail'`,
      [stagingId, slackConnId],
    );

    const refused = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(428);
    expect(refused.body.detail).toBe(
      'staging\'s gmail account is for another app, so "Email me the report" can\'t run there — reassign it under Integrations → Environments before promoting here',
    );
    expect(refused.body.code).toBe('environment_slots_unfit');
    expect(refused.body.steps).toEqual([
      { node_id: 'mail', node_name: 'Email me the report', app: 'gmail', reason: 'wrong_app_slot' },
    ]);
  });

  it('refuses a slot account with its own credentials for a step only one-click accounts run, and promotes once it is one', async () => {
    const doc = irDoc();
    const reminding = {
      ...doc,
      name: 'reminds me',
      nodes: [
        (doc.nodes as unknown[])[0],
        {
          id: 'remind',
          name: 'Remind me',
          node_type: 'slack.create_a_reminder',
          type_version: 1,
          parameters: { text: 'Standup', time: 'in 5 minutes' },
          position: { x: 200, y: 0 },
          metadata: {},
        },
      ],
      edges: [{ ...(doc.edges as Array<Record<string, unknown>>)[0], target_node_id: 'remind' }],
    };
    const deployed = await as(http().post('/api/deploy').send({ workflow_json: reminding })).expect(201);
    const wf = deployed.body.workflow_id as string;
    const versions = await as(http().get(`/api/workflows/${wf}/versions`)).expect(200);
    const v1 = (versions.body.versions as Array<{ id: string }>)[0]!.id;
    await as(
      http().put(`/api/environments/${stagingId}/slots/slack`).send({ connection_id: slackConnId }),
    ).expect(200);

    const refused = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(428);
    expect(refused.body.detail).toBe(
      'staging\'s slack account uses its own credentials, and "Remind me" runs only on a one-click (managed) one, so it can\'t run there — reassign it under Integrations → Environments before promoting here',
    );
    expect(refused.body.code).toBe('environment_slots_unfit');

    const connections = app.get(ConnectionsService);
    const oneClick = (await connections.createManaged(userId, 'slack', 'ca_slot_preflight')).id;
    await connections.setStatus(oneClick, 'active');
    await as(
      http().put(`/api/environments/${stagingId}/slots/slack`).send({ connection_id: oneClick }),
    ).expect(200);
    const promoted = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(201);
    expect(promoted.body.status).toBe('promoted');
    await as(
      http().put(`/api/environments/${stagingId}/slots/slack`).send({ connection_id: slackConnId }),
    ).expect(200);
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

  it('refuses an app trigger whose app has no slot there, naming it as a step is named', async () => {
    const gmailConn = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, status) VALUES ($1, $2, 'gmail', 'token', 'x', 'active')`,
      [gmailConn, userId],
    );
    const doc = irDoc();
    const watching = {
      ...doc,
      name: 'watches mail',
      nodes: [
        {
          id: 'watch',
          name: 'New email',
          node_type: 'gmail.new_email',
          type_version: 1,
          parameters: { connectionId: gmailConn },
          position: { x: 0, y: 0 },
          metadata: { trigger: true },
        },
        ...(doc.nodes as unknown[]).slice(1),
      ],
      edges: (doc.edges as Array<Record<string, unknown>>).map((edge) =>
        edge.source_node_id === 'trigger' ? { ...edge, source_node_id: 'watch' } : edge,
      ),
    };
    const deployed = await as(http().post('/api/deploy').send({ workflow_json: watching })).expect(201);
    const wf = deployed.body.workflow_id as string;
    const versions = await as(http().get(`/api/workflows/${wf}/versions`)).expect(200);
    const v1 = (versions.body.versions as Array<{ id: string }>)[0]!.id;
    await db.query(`DELETE FROM environment_connections WHERE environment_id = $1 AND app = 'gmail'`, [
      stagingId,
    ]);

    const refused = await as(
      http().post(`/api/workflows/${wf}/promote`).send({ environment: 'staging', version_id: v1 }),
    ).expect(428);
    expect(refused.body.detail).toBe(
      'staging has no gmail account assigned, so "New email" can\'t run there — assign one under Integrations → Environments before promoting here',
    );
    expect(refused.body).toMatchObject({
      code: 'environment_slots_empty',
      apps: ['gmail'],
      steps: [],
      triggers: [{ node_id: 'watch', node_name: 'New email', app: 'gmail', reason: 'empty_slot' }],
    });
  });
});
