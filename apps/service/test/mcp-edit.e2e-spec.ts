import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean };
type Edge = {
  id: string;
  source_node_id: string;
  source_port: number;
  target_node_id: string;
  target_port: number;
  port_type: string;
};
type Node = { id: string; name: string; parameters: Record<string, unknown>; position: { x: number } };
type EditResult = { workflow_ir: { name: string; nodes: Node[]; edges: Edge[] }; applied: string[] };

const WF_NAME = 'Expense Triage';
const SLACK = 'slack.send_channel_message';

/**
 * The mutation half of the authoring loop (ADR 0052): `orchestr_edit_workflow` over the real MCP
 * client. Every assertion here is about a document in flight — the tool writes nothing.
 */
describe('Platform MCP workflow editing (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;
  let client: McpClient;

  const userId = randomUUID();
  const orgId = randomUUID();
  const workflowId = randomUUID();
  const branchId = randomUUID();
  const versionId = randomUUID();

  const editKey = 'ork_mcpedit_key_aaaaaaaaaaaaaaaaaa';

  const node = (id: string, nodeType: string, parameters: Record<string, unknown>, x: number) => ({
    id,
    name: id,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x, y: 300 },
    metadata: {},
  });

  const edge = (over: Partial<Edge>): Edge => ({
    id: 'e-notify-fallback',
    source_node_id: 'notify',
    source_port: 0,
    target_node_id: 'fallback',
    target_port: 0,
    port_type: 'main',
    ...over,
  });

  /**
   * The invariant #13 hazard, built by hand because that is how the canvas writes it: `notify` and
   * `fallback` are joined by BOTH a main and an error edge, and the two SHARE an id — so anything
   * that removed an edge by its id label would take out both lanes.
   */
  const irJson = (): Record<string, unknown> => ({
    version: '1',
    name: 'Expense triage document',
    description: 'The stored document',
    nodes: [
      node('trigger', 'orchestr:trigger', {}, 60),
      node('notify', SLACK, { channel: '#finance', text: 'Large expense', threadTs: '123' }, 360),
      node('fallback', SLACK, { channel: '#ops' }, 660),
    ],
    edges: [
      edge({ id: 'e-trigger-notify', source_node_id: 'trigger', target_node_id: 'notify' }),
      edge({}),
      edge({ port_type: 'error' }),
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  }

  async function edit(ops: Record<string, unknown>[]): Promise<EditResult> {
    const result = await call('orchestr_edit_workflow', { workflow_ir: irJson(), ops });
    expect(result.isError).toBeFalsy();
    return result.structuredContent as unknown as EditResult;
  }

  async function storedIr(): Promise<Record<string, unknown>[]> {
    const { rows } = await db.query<{ workflow_ir: Record<string, unknown> }>(
      `SELECT workflow_ir FROM workflow_versions WHERE workflow_id = $1 ORDER BY version_number`,
      [workflowId],
    );
    return rows.map((row) => row.workflow_ir);
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'mcpedit@e2e.local', 'MCP Editor', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'MCP Edit Workspace', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'edit', $3, 'ork_mcpedit', '["workflow:read","workflow:write"]', now())`,
      [userId, orgId, createHash('sha256').update(editKey, 'utf8').digest('hex')],
    );
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, $2, 'generated', $3, $4, now(), now())`,
      [workflowId, WF_NAME, userId, orgId],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $2, 'main', true, true, now())`,
      [branchId, workflowId],
    );
    await db.query(
      `INSERT INTO workflow_versions
         (id, workflow_id, version_number, workflow_json, workflow_ir, commit_message, branch_id, created_at)
       VALUES ($1, $2, 1, $3, $3, 'Initial', $4, now())`,
      [versionId, workflowId, JSON.stringify(irJson()), branchId],
    );
    await db.query(`UPDATE workflows SET default_branch_id = $1 WHERE id = $2`, [branchId, workflowId]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [versionId, branchId]);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    // Composio projection OFF (ADR 0046): the trigger half of the vocabulary makes no live call.

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    client = new McpClient({ name: 'orchestr-edit-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${editKey}` } },
      }),
    );
  }, 40_000);

  afterAll(async () => {
    await client.close();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('advertises itself as a tool that reads rather than writes', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'orchestr_edit_workflow');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description?.startsWith('Persists NOTHING')).toBe(true);
  });

  it('disconnect removes ONLY the named lane — the error edge sharing its id survives (invariant #13)', async () => {
    const before = irJson().edges as Edge[];
    expect(before.filter((e) => e.id === 'e-notify-fallback')).toHaveLength(2); // the hazard is real

    const out = await edit([{ op: 'disconnect', source_node_id: 'notify', target_node_id: 'fallback' }]);

    const survivors = out.workflow_ir.edges.filter((e) => e.id === 'e-notify-fallback');
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toEqual({
      id: 'e-notify-fallback',
      source_node_id: 'notify',
      source_port: 0,
      target_node_id: 'fallback',
      target_port: 0,
      port_type: 'error',
    });
    // The unrelated edge is untouched, and the summary names the lane that went.
    expect(out.workflow_ir.edges.map((e) => e.id)).toEqual(['e-trigger-notify', 'e-notify-fallback']);
    expect(out.applied).toEqual(['disconnected main "notify"[0] → "fallback"[0]']);
  });

  it('disconnect takes the ERROR lane when asked, leaving the main edge that shares its id', async () => {
    const out = await edit([
      { op: 'disconnect', source_node_id: 'notify', target_node_id: 'fallback', port_type: 'error' },
    ]);
    const survivors = out.workflow_ir.edges.filter((e) => e.id === 'e-notify-fallback');
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.port_type).toBe('main');
  });

  it('disconnect + connect rewires without churning node identity', async () => {
    const out = await edit([
      { op: 'disconnect', source_node_id: 'trigger', target_node_id: 'notify' },
      { op: 'add_node', node: { id: 'triage', node_type: SLACK, parameters: { channel: '#triage' } } },
      { op: 'connect', source_node_id: 'trigger', target_node_id: 'triage' },
      { op: 'connect', source_node_id: 'triage', target_node_id: 'notify' },
    ]);

    expect(out.workflow_ir.nodes.map((n) => n.id)).toEqual(['trigger', 'notify', 'fallback', 'triage']);
    // `notify` kept its id AND its parameters — it was rewired, not re-created.
    expect(out.workflow_ir.nodes.find((n) => n.id === 'notify')?.parameters).toEqual({
      channel: '#finance',
      text: 'Large expense',
      threadTs: '123',
    });
    expect(out.workflow_ir.edges.map((e) => `${e.source_node_id}->${e.target_node_id}`)).toEqual([
      'notify->fallback',
      'notify->fallback',
      'trigger->triage',
      'triage->notify',
    ]);
    // Positions are computed server-side: the new node lands on the grid, never at 0,0.
    expect(out.workflow_ir.nodes.find((n) => n.id === 'triage')?.position.x).toBeGreaterThan(0);
  });

  it('disconnect refuses a miss and lists the edges that DO exist', async () => {
    const result = await call('orchestr_edit_workflow', {
      workflow_ir: irJson(),
      ops: [{ op: 'disconnect', source_node_id: 'notify', target_node_id: 'fallback', port_type: 'tool' }],
    });
    expect(result.isError).toBe(true);
    const message = String(result.structuredContent?.error);
    expect(message).toContain('ops[0] disconnect: no edge matching tool "notify"[0] → "fallback"[0]');
    expect(message).toContain('main "notify"[0] → "fallback"[0]');
    expect(message).toContain('error "notify"[0] → "fallback"[0]');
  });

  it('unset_parameters clears the named keys and leaves the rest of the step alone', async () => {
    const out = await edit([{ op: 'unset_parameters', node_id: 'notify', keys: ['text', 'threadTs'] }]);

    const notify = out.workflow_ir.nodes.find((n) => n.id === 'notify');
    expect(notify?.parameters).toEqual({ channel: '#finance' });
    expect(out.applied).toEqual(['cleared parameters on "notify": text, threadTs']);
  });

  it('unset_parameters reports an already-absent key rather than failing the batch', async () => {
    const out = await edit([{ op: 'unset_parameters', node_id: 'notify', keys: ['channel', 'nope'] }]);
    expect(out.applied[0]).toBe('cleared parameters on "notify": channel; already unset: nope');
  });

  it('set_meta renames the DOCUMENT and says so — the workflow row is not renamed', async () => {
    const out = await edit([
      { op: 'set_meta', name: 'Expense triage v2', description: 'Now with a fallback' },
    ]);

    expect(out.workflow_ir.name).toBe('Expense triage v2');
    expect(out.applied[0]).toContain('NOT the workflow itself');

    // The claim, verified against the database rather than taken on the tool's word.
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM workflows WHERE id = $1`, [
      workflowId,
    ]);
    expect(rows[0]?.name).toBe(WF_NAME);
  });

  it('a bad op names its own index, and the whole batch is rejected', async () => {
    const result = await call('orchestr_edit_workflow', {
      workflow_ir: irJson(),
      ops: [
        { op: 'unset_parameters', node_id: 'notify', keys: ['text'] },
        { op: 'set_meta', name: 'Half applied?' },
        { op: 'add_node', node: { id: 'dragon', node_type: 'slack.summon_dragon' } },
      ],
    });

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toMatch(
      /ops\[2\] add_node "dragon": unknown action type "slack\.summon_dragon"/,
    );
    // Atomic: nothing from the earlier ops comes back.
    expect(result.structuredContent?.workflow_ir).toBeUndefined();
  });

  it('an unknown node id names the ids that do exist', async () => {
    const result = await call('orchestr_edit_workflow', {
      workflow_ir: irJson(),
      ops: [{ op: 'unset_parameters', node_id: 'ghost', keys: ['text'] }],
    });
    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toContain(
      'ops[0] unset_parameters: no node with id "ghost" — existing node ids: trigger, notify, fallback',
    );
  });

  it('edits a document lifted from orchestr_get_workflow (no positions, no settings)', async () => {
    const read = await call('orchestr_get_workflow', { workflow_id: workflowId });
    const view = read.structuredContent as unknown as { nodes: unknown[]; edges: unknown[] };

    const result = await call('orchestr_edit_workflow', {
      workflow_ir: { nodes: view.nodes, edges: view.edges },
      ops: [
        { op: 'disconnect', source_node_id: 'notify', target_node_id: 'fallback', port_type: 'error' },
        { op: 'update_node', node_id: 'fallback', parameters: { text: 'Escalated' } },
      ],
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as unknown as EditResult;
    expect(out.workflow_ir.edges.filter((e) => e.port_type === 'error')).toHaveLength(0);
    expect(out.workflow_ir.nodes.find((n) => n.id === 'fallback')?.parameters).toMatchObject({
      channel: '#ops',
      text: 'Escalated',
    });
    // The projection carries no coordinates; the tool returns a document the canvas can draw.
    expect(out.workflow_ir.nodes.every((n) => Number.isFinite(n.position.x))).toBe(true);
  });

  it('every edit above persisted NOTHING: the workflow still has exactly its one original version', async () => {
    const versions = await storedIr();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toEqual(irJson());

    // And the read tool still sees the untouched graph, both lanes included.
    const read = await call('orchestr_get_workflow', { workflow_id: workflowId });
    const view = read.structuredContent as unknown as { nodes: Node[]; edges: Edge[] };
    expect(view.nodes.map((n) => n.id)).toEqual(['trigger', 'notify', 'fallback']);
    expect(view.edges.filter((e) => e.id === 'e-notify-fallback').map((e) => e.port_type)).toEqual([
      'main',
      'error',
    ]);
    expect(view.nodes.find((n) => n.id === 'notify')?.parameters).toEqual({
      channel: '#finance',
      text: 'Large expense',
      threadTs: '123',
    });
  });
});
