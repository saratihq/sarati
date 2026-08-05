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
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean };

/** A trigger feeding one REAL catalog action, so the author-time gate passes. */
const irDoc = (marker: string): Record<string, unknown> => ({
  version: '1',
  name: `doc-${marker}`,
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
      id: 'join',
      name: 'Join Text',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { subject: marker },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e1',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'join',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** The authoring tools that LAND something, driven by the real MCP client over the real transport (ADR 0052). */
describe('Platform MCP create surface (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;
  let client: McpClient;

  const userId = randomUUID();
  const orgId = randomUUID();
  const foreignUserId = randomUUID();
  const foreignOrgId = randomUUID();
  const foreignWfId = randomUUID();
  const foreignBranchId = randomUUID();
  const foreignVersionId = randomUUID();

  const authorKey = 'ork_mcpnew_auth_key_aaaaaaaaaaaaaaa';
  const readKey = 'ork_mcpnew_read_key_bbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

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

  /** Create a draft through the tool and return the ids the assertions need. */
  async function createWorkflow(
    name: string,
    marker: string,
  ): Promise<{ workflowId: string; versionId: string }> {
    const result = await call('orchestr_create_workflow', { name, workflow_ir: irDoc(marker) });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent ?? {};
    return { workflowId: String(out.workflow_id), versionId: String(out.version_id) };
  }

  /** The one write path the create tools do NOT own — used to prove per-branch numbering after a fork. */
  function commit(workflowId: string, branch: string, marker: string, base: string): request.Test {
    return request(app.getHttpServer())
      .post(`/api/workflows/${workflowId}/commit`)
      .set('Authorization', `Bearer ${authorKey}`)
      .send({
        workflow_ir: irDoc(marker),
        branch,
        commit_message: `edit ${marker}`,
        base_version_id: base,
      });
  }

  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
    (await db.query(sql, params)).rows as T[];

  const countWorkflows = async (): Promise<number> =>
    Number((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM workflows`, []))[0]?.n);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'author@e2e.local', 'MCP Author', now(), now()),
              ($2, 'foreign@e2e.local', 'Foreign Owner', now(), now())`,
      [userId, foreignUserId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Author Workspace', false, now(), now()),
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
       VALUES (gen_random_uuid(), $1, $2, 'author', $3, 'ork_mcpnew_a', '["workflow:read","workflow:write"]', now()),
              (gen_random_uuid(), $1, $2, 'read',   $4, 'ork_mcpnew_r', '["workflow:read"]', now())`,
      [userId, orgId, hash(authorKey), hash(readKey)],
    );

    // Another tenant's workflow, with a version an outsider must not be able to fork from.
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'Foreign Flow', 'generated', $2, $3, now(), now())`,
      [foreignWfId, foreignUserId, foreignOrgId],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $2, 'main', true, false, now())`,
      [foreignBranchId, foreignWfId],
    );
    await db.query(
      `INSERT INTO workflow_versions
         (id, workflow_id, version_number, workflow_json, workflow_ir, commit_message, branch_id, created_at)
       VALUES ($1, $2, 1, $3, $3, 'Foreign v1', $4, now())`,
      [foreignVersionId, foreignWfId, JSON.stringify(irDoc('foreign')), foreignBranchId],
    );
    await db.query(`UPDATE workflows SET default_branch_id = $1 WHERE id = $2`, [
      foreignBranchId,
      foreignWfId,
    ]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [
      foreignVersionId,
      foreignBranchId,
    ]);

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
    client = await connect(authorKey);
  }, 40_000);

  afterAll(async () => {
    await client.close();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('orchestr_create_workflow lands v1 on the default branch through the real commit path', async () => {
    const result = await call('orchestr_create_workflow', {
      name: 'Agent Draft',
      workflow_ir: irDoc('create'),
      description: 'built by an agent',
    });
    const out = result.structuredContent ?? {};

    expect(result.isError).toBeFalsy();
    expect(out.name).toBe('Agent Draft');
    expect(out.branch).toBe('main');
    expect(out.version_number).toBe(1);

    const wfId = String(out.workflow_id);
    const versions = await rows<{ id: string; version_number: number; branch_id: string }>(
      `SELECT id, version_number, branch_id FROM workflow_versions WHERE workflow_id = $1`,
      [wfId],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version_number).toBe(1);
    expect(versions[0]?.id).toBe(out.version_id);

    const branches = await rows<{ id: string; name: string; is_default: boolean; head_version_id: string }>(
      `SELECT id, name, is_default, head_version_id FROM workflow_branches WHERE workflow_id = $1`,
      [wfId],
    );
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ name: 'main', is_default: true, head_version_id: out.version_id });
    expect(versions[0]?.branch_id).toBe(branches[0]?.id);

    // The version was minted by commit(), not hand-built: only that path emits workflow.committed.
    const eventsOn = async (subjectId: string): Promise<string[]> =>
      (await rows<{ type: string }>(`SELECT type FROM domain_events WHERE subject_id = $1`, [subjectId])).map(
        (e) => e.type,
      );
    expect(await eventsOn(wfId)).toEqual(['workflow.created']);
    expect(await eventsOn(String(out.version_id))).toEqual(['workflow.committed']);

    // The row and the stored document agree on the name.
    const [stored] = await rows<{ name: string; doc: { name: string } }>(
      `SELECT w.name, v.workflow_ir AS doc FROM workflows w
         JOIN workflow_versions v ON v.id = $2 WHERE w.id = $1`,
      [wfId, out.version_id],
    );
    expect(stored?.name).toBe('Agent Draft');
    expect(stored?.doc.name).toBe('Agent Draft');
  });

  it('a created workflow is NOT live: no env pointer, no active version, and it says so', async () => {
    const result = await call('orchestr_create_workflow', {
      name: 'Never Live',
      workflow_ir: irDoc('draft'),
    });
    const out = result.structuredContent ?? {};
    expect(out.is_live).toBe(false);
    expect(String(out.next_step)).toContain('Nothing runs yet');

    const wfId = String(out.workflow_id);
    const [wf] = await rows<{ active_version_id: string | null }>(
      `SELECT active_version_id FROM workflows WHERE id = $1`,
      [wfId],
    );
    expect(wf?.active_version_id).toBeNull();

    const pointers = await rows(`SELECT environment FROM workflow_env_pointers WHERE workflow_id = $1`, [
      wfId,
    ]);
    expect(pointers).toHaveLength(0);

    // The read surface agrees with the tool: live nowhere.
    const listed = (await call('orchestr_list_workflows', { query: 'Never Live' })).structuredContent ?? {};
    expect((listed.workflows as { id: string; is_live: boolean }[])[0]).toMatchObject({
      id: wfId,
      is_live: false,
    });
  });

  it('a document the author-time gate refuses is refused at create — and nothing is created', async () => {
    const before = await countWorkflows();
    const doc = irDoc('bad') as { nodes: { node_type: string }[] };
    doc.nodes[1]!.node_type = 'slack.update_profile'; // not in the catalog

    const result = await call('orchestr_create_workflow', { name: 'Doomed', workflow_ir: doc });

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toContain('slack.update_profile');
    expect(await countWorkflows()).toBe(before);
    expect(await rows(`SELECT id FROM workflows WHERE name = 'Doomed'`, [])).toHaveLength(0);
  });

  it('a created branch INHERITS the fork point; its own first commit is v1 while main keeps its number', async () => {
    const { workflowId, versionId: mainV1 } = await createWorkflow('Fork Source', 'fork');
    const mainV2 = (await commit(workflowId, 'main', 'main-second', mainV1).expect(201)).body as {
      id: string;
      version_number: number;
    };
    expect(mainV2.version_number).toBe(2);

    const result = await call('orchestr_create_branch', { workflow_id: workflowId, name: 'agent-lane' });
    const out = result.structuredContent ?? {};

    expect(result.isError).toBeFalsy();
    expect(out.branch).toEqual({ name: 'agent-lane', is_default: false, is_protected: false });
    expect(out.fork_point).toEqual({ version_id: mainV2.id, version_number: 2, branch: 'main' });
    expect(out.next_version_number).toBe(1);
    expect(out.is_live).toBe(false);

    // Inherited, not copied: the branch starts with ZERO versions of its own, pointed at main's head.
    const [branch] = await rows<{ id: string; head_version_id: string }>(
      `SELECT id, head_version_id FROM workflow_branches WHERE workflow_id = $1 AND name = 'agent-lane'`,
      [workflowId],
    );
    expect(branch?.head_version_id).toBe(mainV2.id);
    expect(
      await rows(`SELECT id FROM workflow_versions WHERE branch_id = $1`, [String(branch?.id)]),
    ).toHaveLength(0);

    // Invariant #1: the branch's first own commit is v1, and main's head keeps its own number.
    // Its base is the INHERITED fork point — the branch's head before it has a version of its own.
    const laneV1 = (await commit(workflowId, 'agent-lane', 'lane-first', mainV2.id).expect(201)).body as {
      version_number: number;
    };
    expect(laneV1.version_number).toBe(1);

    const heads = await rows<{ name: string; version_number: number }>(
      `SELECT b.name, v.version_number FROM workflow_branches b
         JOIN workflow_versions v ON v.id = b.head_version_id
        WHERE b.workflow_id = $1 ORDER BY b.name`,
      [workflowId],
    );
    expect(heads).toEqual([
      { name: 'agent-lane', version_number: 1 },
      { name: 'main', version_number: 2 },
    ]);
    expect(mainV1).not.toBe(mainV2.id);
  });

  it('branching a workflow with no commits yet reports no fork point instead of failing', async () => {
    const wfId = randomUUID();
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'Empty Flow', 'generated', $2, $3, now(), now())`,
      [wfId, userId, orgId],
    );

    const out =
      (await call('orchestr_create_branch', { workflow_id: wfId, name: 'lane' })).structuredContent ?? {};
    expect(out.fork_point).toBeNull();
    expect(out.next_version_number).toBe(1);
  });

  it('creating a branch that already exists is an actionable error, not a crash', async () => {
    const { workflowId } = await createWorkflow('Twice Branched', 'dup');
    await call('orchestr_create_branch', { workflow_id: workflowId, name: 'dup-lane' });

    const again = await call('orchestr_create_branch', { workflow_id: workflowId, name: 'dup-lane' });
    expect(again.isError).toBe(true);
    const message = String(again.structuredContent?.error);
    expect(message).toContain("Branch 'dup-lane' already exists");
    expect(message).toContain('another name');

    expect(
      await rows(`SELECT id FROM workflow_branches WHERE workflow_id = $1 AND name = 'dup-lane'`, [
        workflowId,
      ]),
    ).toHaveLength(1);
  });

  it("a branch cannot fork from another workflow's version", async () => {
    const { workflowId } = await createWorkflow('Fork Guard', 'guard');

    const result = await call('orchestr_create_branch', {
      workflow_id: workflowId,
      name: 'stolen',
      from_version_id: foreignVersionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toContain('does not belong to workflow');
    expect(
      await rows(`SELECT id FROM workflow_branches WHERE workflow_id = $1 AND name = 'stolen'`, [workflowId]),
    ).toHaveLength(0);
  });

  it("another org's workflow can be neither branched nor read into", async () => {
    const result = await call('orchestr_create_branch', { workflow_id: foreignWfId, name: 'intruder' });

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toContain('not found'); // unreachable ≡ missing
    expect(
      await rows(`SELECT id FROM workflow_branches WHERE workflow_id = $1 AND name = 'intruder'`, [
        foreignWfId,
      ]),
    ).toHaveLength(0);
  });

  it('a key without workflow:write is never offered the create tools, and cannot call them', async () => {
    const reader = await connect(readKey);
    const { tools } = await reader.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('orchestr_get_workflow');
    expect(names).not.toContain('orchestr_create_workflow');
    expect(names).not.toContain('orchestr_create_branch');

    await expect(
      reader.callTool({
        name: 'orchestr_create_workflow',
        arguments: { name: 'X', workflow_ir: irDoc('x') },
      }),
    ).rejects.toThrow();
    await reader.close();

    expect(await rows(`SELECT id FROM workflows WHERE name = 'X'`, [])).toHaveLength(0);
  });
});
