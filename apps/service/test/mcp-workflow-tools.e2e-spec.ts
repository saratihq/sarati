import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** ADR 0053: a PUBLISHED workflow is a tool an agent can call, and only a published one. */
describe('workflow-as-tool over MCP (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;

  const userId = randomUUID();
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const invokeKey = 'ork_wt_invoke_aaaaaaaaaaaaaaaaaaaa';
  const readKey = 'ork_wt_read_bbbbbbbbbbbbbbbbbbbbbb';
  const deployKey = 'ork_wt_deploy_cccccccccccccccccccc';
  // Keys are pinned to their issuing org (ADR 0051), so publishing elsewhere needs its own key.
  const otherDeployKey = 'ork_wt_other_dddddddddddddddddddd';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const toolDoc = (answer: string, toolName = 'greet_person'): Record<string, unknown> => ({
    version: '1.0',
    name: 'Greeter',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Callable',
        node_type: 'orchestr:tool_trigger',
        type_version: 1,
        parameters: {
          tool_name: toolName,
          description: 'Greets a person by name and returns the greeting.',
          inputs: [{ name: 'who', type: 'string', description: 'Who to greet', required: true }],
        },
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'say',
        name: 'Say',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: [answer, '{{trigger.who}}'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
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
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'wt-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1,'wt@e2e.local','WT',now(),now())`,
      [userId],
    );
    for (const [id, name] of [
      [orgId, 'WT Org'],
      [otherOrgId, 'Other Org'],
    ]) {
      await db.query(
        `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1,$2,false,now(),now())`,
        [id, name],
      );
      await db.query(
        `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(),$1,$2,'owner',now())`,
        [id, userId],
      );
    }
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at)
       VALUES (gen_random_uuid(),$1,$2,'invoke',$3,'ork_wt_invok',$6,now()),
              (gen_random_uuid(),$1,$2,'read',  $4,'ork_wt_read_',$7,now()),
              (gen_random_uuid(),$1,$2,'deploy',$5,'ork_wt_deplo',$8,now()),
              (gen_random_uuid(),$1,$9,'other', $10,'ork_wt_other',$8,now())`,
      [
        userId,
        orgId,
        hash(invokeKey),
        hash(readKey),
        hash(deployKey),
        JSON.stringify(['workflow:invoke']),
        JSON.stringify(['workflow:read']),
        JSON.stringify(['workflow:read', 'workflow:deploy', 'workflow:write']),
        otherOrgId,
        hash(otherDeployKey),
      ],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DBOS_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 40_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  /** `/api/deploy` publishes to production, which is what exposes the tool. */
  async function publish(doc: Record<string, unknown>, org = orgId): Promise<string> {
    const res = await http()
      .post('/api/deploy')
      .set('Authorization', `Bearer ${org === orgId ? deployKey : otherDeployKey}`)
      .set('X-Org-Id', org)
      .send({ workflow_json: doc })
      .expect(201);
    return res.body.workflow_id as string;
  }

  it('a published tool-trigger workflow appears as a tool, named and described by its author', async () => {
    await publish(toolDoc('hello '));

    const client = await connect(invokeKey);
    const { tools } = await client.listTools();
    const greet = tools.find((t) => t.name === 'greet_person');

    expect(greet).toBeDefined();
    expect(greet?.description).toContain('Greets a person by name');
    expect(greet?.inputSchema.required).toEqual(['who']);
    await client.close();
  });

  it('calling it runs the live version and returns the workflow’s own answer', async () => {
    const client = await connect(invokeKey);
    const result = await client.callTool({
      name: 'greet_person',
      arguments: { who: 'ada' },
    });
    const data = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(data.status).toBe('completed');
    expect(data.result).toBe('hello ada');
    expect(typeof data.run_id).toBe('string');
    await client.close();
  });

  it('records the invocation as an agent call, not a manual run', async () => {
    const rows = await db.query<{ source: string }>(
      `SELECT source FROM runtime_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows.rows[0]?.source).toBe('mcp');
  });

  /** The whole point of the separate scope: this key can call the automation and learn nothing else. */
  it('an invoke-only key sees ONLY the published tools — no platform tools at all', async () => {
    const client = await connect(invokeKey);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['greet_person']);
    await client.close();
  });

  it('a read-only key sees the platform tools and NOT the published one', async () => {
    const client = await connect(readKey);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('orchestr_get_workflow');
    expect(names).not.toContain('greet_person');
    await client.close();
  });

  it('an unpublished workflow is not a tool, however it is committed', async () => {
    const wfId = await publish(toolDoc('draft ', 'draft_only'));
    // Un-publish by clearing the production pointer; the workflow and its versions remain.
    await db.query(`DELETE FROM workflow_env_pointers WHERE workflow_id = $1`, [wfId]);
    await db.query(`UPDATE workflows SET active_version_id = NULL WHERE id = $1`, [wfId]);

    const client = await connect(invokeKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('draft_only');
    await client.close();
  });

  it('another org’s published tool is invisible', async () => {
    await publish(toolDoc('other ', 'other_org_tool'), otherOrgId);

    const client = await connect(invokeKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('other_org_tool');
    await client.close();
  });

  it('a workflow whose author picked a reserved name is not offered', async () => {
    await publish(toolDoc('shadow ', 'orchestr_commit'));

    const client = await connect(invokeKey);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('commit');
    expect(names).not.toContain('orchestr_commit');
    await client.close();
  });
});
