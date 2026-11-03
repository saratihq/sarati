import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { seedDefaultEnvironments } from '../src/environments/default-environments';
import { LIVE_RUNS_PER_HOUR } from '../src/mcp/live-run-consent.service';
import { irNode } from './support/golden-docs';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A live run over MCP its workspace has no room for never ran, so it spends nothing an MCP caller is held to (real client, DBOS off). */
describe('run limits over MCP: a refused live run spends nothing (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl = '';
  const userId = randomUUID();
  const orgId = randomUUID();
  const key = 'ork_rl_mcp_aaaaaaaaaaaaaaaaaaaaaaaa';
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  const greeter = {
    version: '1.0',
    name: 'Greeter',
    description: '',
    nodes: [
      irNode('trigger', 'orchestr:tool_trigger', {
        tool_name: 'greet_person',
        description: 'Greets a person by name and returns the greeting.',
        inputs: [{ name: 'who', type: 'string', description: 'Who to greet', required: true }],
      }),
      irNode('say', 'text.concat', { texts: ['hello ', '{{trigger.who}}'], separator: '' }),
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'say',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'rl-mcp-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  // The workspace's one running slot, held by a run nothing here runs.
  const holdTheSlot = () =>
    db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, org_id)
       VALUES ('slot-holder', 'slot-holder', $1, 'p', 'running', now(), $2)`,
      [userId, orgId],
    );
  const freeTheSlot = () => db.query(`DELETE FROM runtime_runs WHERE id = 'slot-holder'`);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1,'rl@e2e.local','RL',now(),now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1,'RL Org',false,now(),now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(),$1,$2,'owner',now())`,
      [orgId, userId],
    );
    await seedDefaultEnvironments(db, orgId);
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at)
       VALUES (gen_random_uuid(),$1,$2,'all',$3,'ork_rl_mcp_a',$4,now())`,
      [
        userId,
        orgId,
        createHash('sha256').update(key, 'utf8').digest('hex'),
        JSON.stringify([
          'workflow:invoke',
          'workflow:read',
          'workflow:write',
          'workflow:deploy',
          'run:dry',
          'run:execute',
        ]),
      ],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DBOS_ENABLED = 'false';
    process.env.WORKSPACE_MAX_RUNNING_RUNS = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    await http()
      .post('/api/deploy')
      .set('Authorization', `Bearer ${key}`)
      .set('X-Org-Id', orgId)
      .send({ workflow_json: greeter })
      .expect(201);
  }, 40_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    delete process.env.WORKSPACE_MAX_RUNNING_RUNS;
    process.env.DATABASE_URL = ADMIN_URL;
  });

  afterEach(() => freeTheSlot());

  it('a published tool its workspace has no room for is refused as often as it is called, spending none of the hourly live runs, and runs once a slot frees', async () => {
    const client = await connect();
    try {
      await holdTheSlot();
      for (let i = 0; i <= LIVE_RUNS_PER_HOUR; i++) {
        const refused = await client.callTool({ name: 'greet_person', arguments: { who: `caller ${i}` } });
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({ code: 'workspace_run_limit' });
      }
      await freeTheSlot();

      const greeted = await client.callTool({ name: 'greet_person', arguments: { who: 'at last' } });

      expect(greeted.isError).toBeFalsy();
      expect((greeted.structuredContent as Record<string, unknown>).result).toBe('hello at last');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('a live test run its workspace has no room for keeps its confirmation token, which runs it once a slot frees', async () => {
    const client = await connect();
    const tested = { workflow_ir: greeter, trigger_payload: { who: 'tester' } };
    try {
      const dry = await client.callTool({ name: 'orchestr_test_workflow', arguments: tested });
      const live = {
        ...tested,
        dry_run: false,
        confirmation_token: (dry.structuredContent as Record<string, unknown>).confirmation_token,
      };
      await holdTheSlot();

      const refused = await client.callTool({ name: 'orchestr_test_workflow', arguments: live });

      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ code: 'workspace_run_limit' });
      await freeTheSlot();
      const ran = await client.callTool({ name: 'orchestr_test_workflow', arguments: live });
      expect(ran.isError).toBeFalsy();
      expect(ran.structuredContent).toMatchObject({ dry_run: false, status: 'completed' });
    } finally {
      await client.close();
    }
  }, 60_000);
});
