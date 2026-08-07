import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean };

/** The workflow read tools, driven by the real MCP client over the real transport (ADR 0052). */
describe('Platform MCP workflow reads (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;
  let client: McpClient;

  const userId = randomUUID();
  const orgId = randomUUID();
  const foreignUserId = randomUUID();
  const foreignOrgId = randomUUID();

  const alphaId = randomUUID();
  const betaId = randomUUID();
  const foreignWfId = randomUUID();
  const mainId = randomUUID();
  const featureId = randomUUID();
  const v1Id = randomUUID();
  const v2Id = randomUUID();
  const f1Id = randomUUID();

  const readKey = 'ork_mcpwf_read_key_aaaaaaaaaaaaaaaa';
  const writeOnlyKey = 'ork_mcpwf_writ_key_bbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  /** Two nodes wired by one edge — the graph an agent must be able to see. */
  const irJson = (marker: string): Record<string, unknown> => ({
    version: '1',
    name: `wf-${marker}`,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Trigger',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: { kind: 'webhook' } },
      },
      {
        id: `send-${marker}`,
        name: 'Send Email',
        node_type: 'email.send',
        type_version: 1,
        parameters: { subject: marker },
        position: { x: 300, y: 0 },
        credentials: { secret: 'must-never-be-returned' },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: `send-${marker}`,
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  async function connect(key: string): Promise<McpClient> {
    const connected = new McpClient({ name: 'orchestr-e2e', version: '1.0.0' });
    await connected.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return connected;
  }

  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  }

  const asRead = (req: request.Test): request.Test => req.set('Authorization', `Bearer ${readKey}`);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'mcpwf@e2e.local', 'MCP Owner', now(), now()),
              ($2, 'foreign@e2e.local', 'Foreign Owner', now(), now())`,
      [userId, foreignUserId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'MCP Workspace', false, now(), now()),
              ($2, 'Other Workspace', false, now(), now())`,
      [orgId, foreignOrgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()),
              (gen_random_uuid(), $3, $4, 'owner', now())`,
      [orgId, userId, foreignOrgId, foreignUserId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'read',  $3, 'ork_mcpwf_re', '["workflow:read"]', now()),
              (gen_random_uuid(), $1, $2, 'write', $4, 'ork_mcpwf_wr', '["workflow:write"]', now())`,
      [userId, orgId, hash(readKey), hash(writeOnlyKey)],
    );

    // Alpha: main(v1, v2) + a feature branch with its own v1. Beta: newest, so it leads the list.
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'Alpha Flow', 'generated', $2, $3, now() - interval '2 hour', now() - interval '2 hour'),
              ($4, 'Beta Flow',  'generated', $2, $3, now() - interval '1 hour', now() - interval '1 hour'),
              ($5, 'Foreign Flow', 'generated', $6, $7, now(), now())`,
      [alphaId, userId, orgId, betaId, foreignWfId, foreignUserId, foreignOrgId],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $2, 'main', true, true, now()), ($3, $2, 'feature-x', false, false, now())`,
      [mainId, alphaId, featureId],
    );
    await db.query(
      `INSERT INTO workflow_versions
         (id, workflow_id, version_number, workflow_json, workflow_ir, commit_message, branch_id, parent_id, created_at)
       VALUES ($1, $2, 1, $3, $3, 'Initial', $4, NULL, now() - interval '3 hour'),
              ($5, $2, 2, $6, $6, 'Second',  $4, $1,   now() - interval '2 hour'),
              ($7, $2, 1, $8, $8, 'Feature work', $9, $5, now() - interval '1 hour')`,
      [
        v1Id,
        alphaId,
        JSON.stringify(irJson('v1')),
        mainId,
        v2Id,
        JSON.stringify(irJson('v2')),
        f1Id,
        JSON.stringify(irJson('f1')),
        featureId,
      ],
    );
    await db.query(`UPDATE workflows SET active_version_id = $1, default_branch_id = $2 WHERE id = $3`, [
      v2Id,
      mainId,
      alphaId,
    ]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [v2Id, mainId]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [f1Id, featureId]);
    // Live in two environments: production via the legacy alias above, staging via its own pointer.
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, updated_at)
       VALUES ($1, 'staging', $2, now())`,
      [alphaId, v1Id],
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
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = await connect(readKey);
  }, 40_000);

  afterAll(async () => {
    await client.close();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('orchestr_get_workflow returns the default branch head with BOTH nodes and edges', async () => {
    const result = await call('orchestr_get_workflow', { workflow_id: alphaId });
    const out = result.structuredContent ?? {};

    expect(result.isError).toBeFalsy();
    expect(out.workflow).toEqual({ id: alphaId, name: 'Alpha Flow' });
    expect(out.branch).toMatchObject({ name: 'main', is_default: true, is_protected: true });
    expect(out.version_id).toBe(v2Id);
    expect(out.version_number).toBe(2);

    const nodes = out.nodes as { id: string; node_type: string; metadata: Record<string, unknown> }[];
    expect(nodes.map((n) => n.id)).toEqual(['trigger', 'send-v2']);
    expect(nodes[0]?.metadata).toEqual({ trigger: { kind: 'webhook' } });

    // The graph itself: the defect was a read path that returned nodes and no edges at all.
    const edges = out.edges as Record<string, unknown>[];
    expect(edges).toEqual([
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'send-v2',
        target_port: 0,
        port_type: 'main',
      },
    ]);
  });

  it('orchestr_get_workflow never returns a node credentials block', async () => {
    const result = await call('orchestr_get_workflow', { workflow_id: alphaId });
    const nodes = (result.structuredContent?.nodes ?? []) as Record<string, unknown>[];
    expect(nodes.some((n) => 'credentials' in n)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('must-never-be-returned');
  });

  it('orchestr_get_workflow returns the head of a NON-default branch when asked', async () => {
    const result = await call('orchestr_get_workflow', { workflow_id: alphaId, branch: 'feature-x' });
    const out = result.structuredContent ?? {};

    expect(out.branch).toMatchObject({ name: 'feature-x', is_default: false });
    expect(out.version_id).toBe(f1Id);
    // Per-branch numbering (invariant #1): the feature head is v1 while main's head is v2.
    expect(out.version_number).toBe(1);
    expect((out.nodes as { id: string }[]).map((n) => n.id)).toContain('send-f1');
    expect((out.edges as { target_node_id: string }[])[0]?.target_node_id).toBe('send-f1');
  });

  it('orchestr_get_workflow lists every branch and the versions live per environment', async () => {
    const out = (await call('orchestr_get_workflow', { workflow_id: alphaId })).structuredContent ?? {};

    const branches = out.branches as { name: string; head_version_id: string | null }[];
    expect(branches.map((b) => b.name).sort()).toEqual(['feature-x', 'main']);
    expect(branches.find((b) => b.name === 'feature-x')?.head_version_id).toBe(f1Id);

    expect(out.live_versions).toEqual([
      { environment: 'production', version_id: v2Id, version_number: 2 },
      { environment: 'staging', version_id: v1Id, version_number: 1 },
    ]);
  });

  it('orchestr_get_workflow refuses an unknown branch and an unknown workflow with actionable text', async () => {
    const badBranch = await call('orchestr_get_workflow', { workflow_id: alphaId, branch: 'nope' });
    expect(badBranch.isError).toBe(true);
    expect(String(badBranch.structuredContent?.error)).toContain("Branch 'nope' not found");

    const unknown = await call('orchestr_get_workflow', { workflow_id: randomUUID() });
    expect(unknown.isError).toBe(true);
    expect(String(unknown.structuredContent?.error)).toContain('not found');
  });

  it("another org's workflow is an error, never data", async () => {
    const result = await call('orchestr_get_workflow', { workflow_id: foreignWfId });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.nodes).toBeUndefined();
    expect(String(result.structuredContent?.error)).toContain('not found'); // unreachable ≡ missing
  });

  it('orchestr_list_workflows pages with the opaque cursor and stays inside the org', async () => {
    const first = (await call('orchestr_list_workflows', { limit: 1 })).structuredContent ?? {};
    expect(first.total).toBe(2); // the foreign org's workflow is not in the tenant
    const firstPage = first.workflows as { id: string; name: string }[];
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.name).toBe('Beta Flow'); // most recently created first
    expect(typeof first.next_cursor).toBe('string');

    const second =
      (await call('orchestr_list_workflows', { limit: 1, cursor: first.next_cursor })).structuredContent ??
      {};
    const secondPage = second.workflows as { id: string }[];
    expect(secondPage.map((w) => w.id)).toEqual([alphaId]);
    expect(second.next_cursor).toBeNull();

    const ids = [...firstPage, ...secondPage].map((w) => w.id);
    expect(ids).not.toContain(foreignWfId);
  });

  it('orchestr_list_workflows reports where each workflow is live, and filters by name', async () => {
    const all = (await call('orchestr_list_workflows', {})).structuredContent ?? {};
    const rows = all.workflows as { id: string; is_live: boolean; live_environments: string[] }[];
    expect(rows.find((w) => w.id === alphaId)).toMatchObject({
      is_live: true,
      live_environments: ['production', 'staging'],
    });
    expect(rows.find((w) => w.id === betaId)).toMatchObject({ is_live: false, live_environments: [] });

    const filtered = (await call('orchestr_list_workflows', { query: 'alpha' })).structuredContent ?? {};
    expect((filtered.workflows as { id: string }[]).map((w) => w.id)).toEqual([alphaId]);
    expect(filtered.total).toBe(1);
  });

  it('orchestr_list_workflows rejects a cursor it did not issue', async () => {
    const result = await call('orchestr_list_workflows', { cursor: 'not-a-cursor' });
    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toContain('cursor');
  });

  it('GET /api/workflows/:id returns the edges of the graph, not a vestigial connections map', async () => {
    const res = await asRead(request(app.getHttpServer()).get(`/api/workflows/${alphaId}`)).expect(200);
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.edges).toEqual([
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'send-v2',
        target_port: 0,
        port_type: 'main',
      },
    ]);
    expect(res.body.connections).toBeUndefined();
  });

  it('GET /api/workflows/:id/branches/:name/head reads one branch head, not the whole history', async () => {
    const res = await asRead(
      request(app.getHttpServer()).get(`/api/workflows/${alphaId}/branches/feature-x/head`),
    ).expect(200);

    expect(res.body.workflow_name).toBe('Alpha Flow');
    expect(res.body.branch).toMatchObject({ name: 'feature-x', is_default: false });
    expect(res.body.head).toMatchObject({
      version_id: f1Id,
      version_number: 1,
      commit_message: 'Feature work',
    });
    expect(res.body.head.edges).toHaveLength(1);
    expect(res.body.branches).toHaveLength(2);
    expect(res.body.env_pointers[0].environment).toBe('production');
    // The bloat this route exists to avoid: no per-version diff/ir_diff/workflow_json payloads.
    expect(res.body.head.workflow_json).toBeUndefined();
    expect(res.body.head.ir_diff).toBeUndefined();
  });

  it('the branch-head route is scope-guarded: a key without workflow:read is refused', async () => {
    await request(app.getHttpServer())
      .get(`/api/workflows/${alphaId}/branches/main/head`)
      .set('Authorization', `Bearer ${writeOnlyKey}`)
      .expect(403);
  });
});
