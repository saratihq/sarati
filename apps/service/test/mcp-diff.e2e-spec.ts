import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface DiffSide {
  version_id: string;
  version_number: number;
  branch: string | null;
  commit_message: string | null;
}
interface NodeChange {
  operation: string;
  node_id: string;
  node_name: string | null;
  path: string | null;
  old_value: unknown;
  new_value: unknown;
}
interface EdgeChange {
  operation: string;
  source_node_id: string;
  source_port: number;
  target_node_id: string;
  target_port: number;
  port_type: string;
}
interface ChangeSet {
  workflow_id: string;
  from: DiffSide;
  to: DiffSide;
  summary: string;
  node_changes: NodeChange[];
  edge_changes: EdgeChange[];
  settings_changes: unknown[];
  renames: { old_name: string; new_name: string }[];
  renames_are_presentational: boolean;
}

/** `orchestr_diff` through the real MCP client — the moat tool, so every claim is asserted (ADR 0052). */
describe('orchestr_diff (e2e, real MCP client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;

  const userId = randomUUID();
  const orgId = randomUUID();
  const readKey = 'ork_diff_read_key_dddddddddddddddddd';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const wfId = randomUUID();
  const otherWfId = randomUUID();
  const foreignWfId = randomUUID();
  const mainId = randomUUID();
  const featureId = randomUUID();
  const mainV1 = randomUUID();
  const mainV2 = randomUUID();
  const mainV3 = randomUUID();
  const mainV4 = randomUUID();
  const featV1 = randomUUID();
  const featV2 = randomUUID();
  const otherV1 = randomUUID();

  const mainEdge = {
    id: 'e1',
    source_node_id: 'trigger',
    source_port: 0,
    target_node_id: 'send',
    target_port: 0,
    port_type: 'main',
  };
  // Same id, same endpoints, different port_type — id-keying would collapse the pair (invariant #13).
  const errorEdge = { ...mainEdge, port_type: 'error' };

  const ir = (subject: string, withErrorEdge = false): Record<string, unknown> => ({
    version: '1',
    name: 'diff flow',
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
        id: 'send',
        name: 'Send Email',
        node_type: 'email.send',
        type_version: 1,
        parameters: { subject },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: withErrorEdge ? [mainEdge, errorEdge] : [mainEdge],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  /** A version that adds `count` disconnected nodes — enough ops to blow past the result size cap. */
  const wideIr = (count: number): Record<string, unknown> => {
    const base = ir('v2');
    const extra = Array.from({ length: count }, (_, i) => ({
      id: `bulk_${i}`,
      name: `Bulk ${i}`,
      node_type: 'email.send',
      type_version: 1,
      parameters: { subject: `bulk subject ${i}` },
      position: { x: 600, y: i * 40 },
      metadata: {},
    }));
    return { ...base, nodes: [...(base.nodes as unknown[]), ...extra] };
  };

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'orchestr-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  async function diff(from: string, to: string, workflowId = wfId): Promise<ChangeSet> {
    const client = await connect(readKey);
    try {
      // List first, so the client validates the result against the schema the server advertises.
      await client.listTools();
      const result = await client.callTool({
        name: 'orchestr_diff',
        arguments: { workflow_id: workflowId, from_version_id: from, to_version_id: to },
      });
      expect(result.isError).toBeFalsy();
      return result.structuredContent as ChangeSet;
    } finally {
      await client.close();
    }
  }

  async function refusal(args: Record<string, unknown>): Promise<string> {
    const client = await connect(readKey);
    try {
      const result = await client.callTool({ name: 'orchestr_diff', arguments: args });
      expect(result.isError).toBe(true);
      return (result.content as { type: string; text: string }[])[0]?.text ?? '';
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    const foreignUserId = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'diff@e2e.local', 'Diff Owner', now(), now()),
              ($2, 'foreign@e2e.local', 'Foreign User', now(), now())`,
      [userId, foreignUserId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Diff Workspace', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'read', $3, 'ork_diff_rea', '["workflow:read"]', now())`,
      [userId, orgId, hash(readKey)],
    );

    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'Diff Flow',  'generated', $4, $5, now(), now()),
              ($2, 'Other Flow', 'generated', $4, $5, now(), now()),
              ($3, 'Foreign Flow', 'generated', $6, NULL, now(), now())`,
      [wfId, otherWfId, foreignWfId, userId, orgId, foreignUserId],
    );

    const otherMainId = randomUUID();
    const foreignMainId = randomUUID();
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $3, 'main', true, false, now()),
              ($2, $3, 'feature', false, false, now()),
              ($4, $5, 'main', true, false, now()),
              ($6, $7, 'main', true, false, now())`,
      [mainId, featureId, wfId, otherMainId, otherWfId, foreignMainId, foreignWfId],
    );

    // main: v1 → v2 → v3(+error edge). feature: forked at main v2, its own v1 → v2.
    // So version_number 1 AND 2 each exist on TWO branches — the ambiguity invariant #1 exists to stop.
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, commit_message, branch_id, parent_id, created_at)
       VALUES ($1,  $11, 1, $2,  'main v1',    $12, NULL, now() - interval '5 hour'),
              ($3,  $11, 2, $4,  'main v2',    $12, $1,   now() - interval '4 hour'),
              ($5,  $11, 3, $6,  'error lane', $12, $3,   now() - interval '3 hour'),
              ($7,  $11, 1, $4,  'fork',       $13, $3,   now() - interval '2 hour'),
              ($8,  $11, 2, $9,  'feature v2', $13, $7,   now() - interval '1 hour'),
              ($10, $14, 1, $15, 'other v1',   $16, NULL, now()),
              ($17, $11, 4, $18, 'bulk',       $12, $5,   now())`,
      [
        mainV1,
        JSON.stringify(ir('v1')),
        mainV2,
        JSON.stringify(ir('v2')),
        mainV3,
        JSON.stringify(ir('v2', true)),
        featV1,
        featV2,
        JSON.stringify(ir('feature-2')),
        otherV1,
        wfId,
        mainId,
        featureId,
        otherWfId,
        JSON.stringify(ir('other')),
        otherMainId,
        mainV4,
        JSON.stringify(wideIr(150)),
      ],
    );
    await db.query(`UPDATE workflows SET active_version_id = $1, default_branch_id = $2 WHERE id = $3`, [
      mainV3,
      mainId,
      wfId,
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
  }, 40_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('is listed for a workflow:read key', async () => {
    const client = await connect(readKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('orchestr_diff');
    await client.close();
  });

  it('same branch: the change set is field-level, keyed by (node_id, path)', async () => {
    const changes = await diff(mainV1, mainV2);

    expect(changes.from).toMatchObject({ version_id: mainV1, version_number: 1, branch: 'main' });
    expect(changes.to).toMatchObject({ version_id: mainV2, version_number: 2, branch: 'main' });
    expect(changes.node_changes).toEqual([
      {
        operation: 'modify_node',
        node_id: 'send',
        node_name: 'Send Email',
        path: 'parameters.subject',
        old_value: 'v1',
        new_value: 'v2',
      },
    ]);
    expect(changes.edge_changes).toEqual([]);
    expect(changes.settings_changes).toEqual([]);
    expect(changes.summary).toContain('modification');
    expect(changes.renames_are_presentational).toBe(true);
  });

  it('main@v2 vs feature@v2: version ids resolve exactly where the bare number cannot', async () => {
    const changes = await diff(mainV2, featV2);

    expect(changes.from).toMatchObject({ version_id: mainV2, version_number: 2, branch: 'main' });
    expect(changes.to).toMatchObject({ version_id: featV2, version_number: 2, branch: 'feature' });
    expect(changes.node_changes).toEqual([
      expect.objectContaining({
        node_id: 'send',
        path: 'parameters.subject',
        old_value: 'v2',
        new_value: 'feature-2',
      }),
    ]);
  });

  it('the bare-number path REFUSES the same pair instead of guessing a branch', async () => {
    // Two rows carry version_number 2 (main and feature): the old unfiltered findOne had no branch
    // filter and no ordering, so it returned whichever row Postgres handed back.
    const ambiguous = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_version=2&to_version=2`)
      .set('Authorization', `Bearer ${readKey}`)
      .expect(400);
    expect(ambiguous.body.detail).toContain('ambiguous');
    expect(ambiguous.body.detail).toContain('main');
    expect(ambiguous.body.detail).toContain('feature');

    // A number PLUS its branch is still a legitimate reference.
    const named = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_version=2&to_version=2&from_branch=main&to_branch=feature`)
      .set('Authorization', `Bearer ${readKey}`)
      .expect(200);
    expect(named.body.from_version_id).toBe(mainV2);
    expect(named.body.to_version_id).toBe(featV2);
    expect(named.body.from_branch).toBe('main');
    expect(named.body.to_branch).toBe('feature');
  });

  it('the REST route accepts version ids natively', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/diff?from_version_id=${mainV1}&to_version_id=${mainV2}`)
      .set('Authorization', `Bearer ${readKey}`)
      .expect(200);
    expect(res.body.from_version).toBe(1);
    expect(res.body.to_version).toBe(2);
    expect(res.body.entries).toHaveLength(1);
  });

  it('an error edge is a DISTINCT edge from the main edge that shares its id', async () => {
    const changes = await diff(mainV2, mainV3);

    expect(changes.edge_changes).toEqual([
      {
        operation: 'add_edge',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'send',
        target_port: 0,
        port_type: 'error',
      },
    ]);
    expect(changes.node_changes).toEqual([]);
  });

  it('a change set past the result size cap truncates and still satisfies the advertised schema', async () => {
    const client = await connect(readKey);
    try {
      // Listing first makes the client validate the result against the advertised schema — a
      // truncation note inside structuredContent would be rejected as an undeclared property.
      await client.listTools();
      const result = await client.callTool({
        name: 'orchestr_diff',
        arguments: { workflow_id: wfId, from_version_id: mainV3, to_version_id: mainV4 },
      });
      expect(result.isError).toBeFalsy();

      const changes = result.structuredContent as ChangeSet;
      expect(changes.node_changes.length).toBeGreaterThan(0);
      expect(changes.node_changes.length).toBeLessThan(150);
      expect(Object.keys(changes)).not.toContain('truncation_note');

      const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      expect(text).toContain('node_changes omitted');
      expect(result._meta?.['orchestr/truncation']).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('a version id from a DIFFERENT workflow is refused, not silently diffed', async () => {
    const text = await refusal({
      workflow_id: wfId,
      from_version_id: mainV1,
      to_version_id: otherV1,
    });
    expect(text).toContain(otherV1);
    expect(text).toContain('not found');
  });

  it('an unknown version id is refused', async () => {
    const missing = randomUUID();
    const text = await refusal({
      workflow_id: wfId,
      from_version_id: missing,
      to_version_id: mainV2,
    });
    expect(text).toContain(missing);
    expect(text).toContain('not found');
  });

  it('a bare version_number is not expressible in the tool schema', async () => {
    const text = await refusal({ workflow_id: wfId, from_version: 1, to_version: 2 });
    expect(text).toContain('from_version_id');
  });

  it('a workflow the key cannot read is refused on both the tool and the REST seam', async () => {
    const text = await refusal({
      workflow_id: foreignWfId,
      from_version_id: mainV1,
      to_version_id: mainV2,
    });
    expect(text).toContain('not found'); // unreachable ≡ missing

    const rest = await request(app.getHttpServer())
      .get(`/api/workflows/${foreignWfId}/diff?from_version=1&to_version=2`)
      .set('Authorization', `Bearer ${readKey}`)
      .expect(404);
    expect(rest.body.detail).toContain('not found');
  });
});
