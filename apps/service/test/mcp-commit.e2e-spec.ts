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

interface CommitResult {
  version_id: string;
  version_number: number;
  branch: string;
  no_changes: boolean;
  ref_warnings: string[];
  is_live: boolean;
  live_versions: { environment: string; version_id: string; version_number: number }[];
}

interface Seeded {
  workflowId: string;
  v1Id: string;
}

/**
 * `orchestr_commit` through the real MCP client (ADR 0052): the tool the moat rides on, so the
 * concurrency token, the 409 recipe and "save ≠ live" are each asserted end to end.
 */
describe('orchestr_commit (e2e, real MCP client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;

  const agentUserId = randomUUID();
  const otherUserId = randomUUID();
  const orgId = randomUUID();
  const agentKey = 'ork_commit_agent_key_aaaaaaaaaaaaaa';
  const otherKey = 'ork_commit_other_key_bbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const ir = (texts: string[], separator = '', name = 'commit probe'): Record<string, unknown> => ({
    version: '1',
    name,
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
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts, separator },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'orchestr-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  /** A committed result, with the MCP client validating it against the advertised output schema. */
  async function commit(args: Record<string, unknown>): Promise<CommitResult> {
    const client = await connect(agentKey);
    try {
      await client.listTools();
      const result = await client.callTool({ name: 'orchestr_commit', arguments: args });
      expect(result.isError).toBeFalsy();
      return result.structuredContent as CommitResult;
    } finally {
      await client.close();
    }
  }

  async function refusal(args: Record<string, unknown>): Promise<string> {
    const client = await connect(agentKey);
    try {
      const result = await client.callTool({ name: 'orchestr_commit', arguments: args });
      expect(result.isError).toBe(true);
      return (result.content as { type: string; text: string }[])[0]?.text ?? '';
    } finally {
      await client.close();
    }
  }

  /** A workflow whose main branch holds exactly v1, live in production. */
  async function seed(name: string, doc: Record<string, unknown>): Promise<Seeded> {
    const workflowId = randomUUID();
    const branchId = randomUUID();
    const v1Id = randomUUID();
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, $2, 'generated', $3, $4, now(), now())`,
      [workflowId, name, agentUserId, orgId],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $2, 'main', true, false, now())`,
      [branchId, workflowId],
    );
    await db.query(
      `INSERT INTO workflow_versions
         (id, workflow_id, version_number, workflow_json, workflow_ir, commit_message, branch_id, parent_id, created_at)
       VALUES ($1, $2, 1, $3, $3, 'v1', $4, NULL, now())`,
      [v1Id, workflowId, JSON.stringify(doc), branchId],
    );
    await db.query(`UPDATE workflows SET active_version_id = $1, default_branch_id = $2 WHERE id = $3`, [
      v1Id,
      branchId,
      workflowId,
    ]);
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [v1Id, branchId]);
    return { workflowId, v1Id };
  }

  async function versionCount(workflowId: string): Promise<number> {
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workflow_versions WHERE workflow_id = $1`,
      [workflowId],
    );
    return rows.rows[0]?.n ?? 0;
  }

  async function liveVersionId(workflowId: string): Promise<string | null> {
    const rows = await db.query<{ active_version_id: string | null }>(
      `SELECT active_version_id FROM workflows WHERE id = $1`,
      [workflowId],
    );
    return rows.rows[0]?.active_version_id ?? null;
  }

  /** Another author commits to the same branch, the way a human's canvas save would. */
  async function commitAsOtherAuthor(
    workflowId: string,
    doc: Record<string, unknown>,
    baseVersionId: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/api/workflows/${workflowId}/commit`)
      .set('Authorization', `Bearer ${otherKey}`)
      .send({ workflow_ir: doc, branch: 'main', base_version_id: baseVersionId })
      .expect(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'agent@e2e.local', 'Agent Owner', now(), now()),
              ($2, 'human@e2e.local', 'Other Author', now(), now())`,
      [agentUserId, otherUserId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Commit Workspace', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()),
              (gen_random_uuid(), $1, $3, 'admin', now())`,
      [orgId, agentUserId, otherUserId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $3, 'agent', $4, 'ork_commit_a', '["workflow:read","workflow:write"]', now()),
              (gen_random_uuid(), $2, $3, 'other', $5, 'ork_commit_o', '["workflow:read","workflow:write"]', now())`,
      [agentUserId, otherUserId, orgId, hash(agentKey), hash(otherKey)],
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
  }, 40_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('is listed for a key holding workflow:write', async () => {
    const client = await connect(agentKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('orchestr_commit');
    await client.close();
  });

  it('lands a version on the branch and never moves the live pointer', async () => {
    const { workflowId, v1Id } = await seed('commit lands', ir(['v1']));

    const result = await commit({
      workflow_id: workflowId,
      workflow_ir: ir(['v2']),
      branch: 'main',
      base_version_id: v1Id,
      message: 'agent edit',
    });

    expect(result.version_number).toBe(2);
    expect(result.branch).toBe('main');
    expect(result.no_changes).toBe(false);
    expect(result.version_id).not.toBe(v1Id);

    // Save ≠ live (invariant #2): the pointer names the version this commit did NOT touch.
    expect(result.is_live).toBe(false);
    expect(result.live_versions).toEqual([
      { environment: 'production', version_id: v1Id, version_number: 1 },
    ]);
    expect(await liveVersionId(workflowId)).toBe(v1Id);
    expect(await versionCount(workflowId)).toBe(2);
  });

  it('refuses an API-key commit with no base_version_id — identically on the tool and on the REST route the same token opens', async () => {
    const { workflowId } = await seed('commit needs base', ir(['v1']));

    const toolText = await refusal({
      workflow_id: workflowId,
      workflow_ir: ir(['v2']),
      branch: 'main',
    });

    const rest = await request(app.getHttpServer())
      .post(`/api/workflows/${workflowId}/commit`)
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ workflow_ir: ir(['v2']), branch: 'main' })
      .expect(400);

    expect(toolText).toContain('base_version_id is required');
    // The refusal lives in the write service, so the bearer that skips the tool meets the same words.
    // The tool prefixes the machine code, which REST carries in its own `code` field instead.
    expect(toolText).toBe(`base_version_id_required: ${rest.body.detail as string}`);
    expect(rest.body.code).toBe('base_version_id_required');
    expect(await versionCount(workflowId)).toBe(1);
  });

  it('409s when another author committed mid-loop, and the refusal carries the base/ours/theirs recipe', async () => {
    const { workflowId, v1Id } = await seed('commit recipe', ir(['v1']));
    // The other author touches a DIFFERENT field of the same node, so the merge is clean.
    const v2Id = await commitAsOtherAuthor(workflowId, ir(['v1'], ' | '), v1Id);

    const text = await refusal({
      workflow_id: workflowId,
      workflow_ir: ir(['agent']),
      branch: 'main',
      base_version_id: v1Id,
    });

    expect(text).toContain('moved on');
    expect(text).toContain(`v2 (${v2Id})`);
    expect(text).toContain(`base = the version at base_version_id (${v1Id})`);
    expect(text).toContain('ours = the new branch head');
    expect(text).toContain('theirs = the document you just sent');
    expect(text).toContain('That merge is clean');
    expect(text).toContain('base_version_id set to the new head');
    // A clean merge is still a refusal: committing the stale draft would drop the other author's field.
    expect(await versionCount(workflowId)).toBe(2);

    const rest = await request(app.getHttpServer())
      .post(`/api/workflows/${workflowId}/commit`)
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ workflow_ir: ir(['agent']), branch: 'main', base_version_id: v1Id })
      .expect(409);
    expect(rest.body.code).toBe('branch_moved');
    expect(rest.body.current_head_version_id).toBe(v2Id);
    expect(rest.body.current_head_version_number).toBe(2);
    expect(rest.body.merge).toEqual({
      base: v1Id,
      ours: v2Id,
      theirs: 'the submitted document',
    });
    expect(rest.body.conflicts).toEqual([]);

    // Re-based onto the head the recipe named, the commit lands.
    const landed = await commit({
      workflow_id: workflowId,
      workflow_ir: ir(['agent'], ' | '),
      branch: 'main',
      base_version_id: v2Id,
    });
    expect(landed.version_number).toBe(3);
  });

  it('names a real field conflict in the refusal, and never lands the ours-wins auto-merge', async () => {
    const { workflowId, v1Id } = await seed('commit conflict', ir(['base']));
    const v2Id = await commitAsOtherAuthor(workflowId, ir(['human']), v1Id);

    const text = await refusal({
      workflow_id: workflowId,
      workflow_ir: ir(['agent']),
      branch: 'main',
      base_version_id: v1Id,
    });

    expect(text).toContain('1 field-level conflict must be resolved by hand');
    expect(text).toContain('Announce (parameters.texts)');
    expect(text).toContain('never auto-resolves a field conflict for you');
    expect(await versionCount(workflowId)).toBe(2);

    // The mandated merge, run exactly as the recipe maps it: it auto-resolves OURS-WINS and
    // reports the collision — which is why its output is never a commit.
    const merged = await request(app.getHttpServer())
      .post('/api/compose/merge')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ base: ir(['base']), ours: ir(['human']), theirs: ir(['agent']) })
      .expect(201);
    expect(merged.body.conflicts).toHaveLength(1);
    expect(merged.body.conflicts[0]).toMatchObject({
      node_id: 'announce',
      field_path: 'parameters.texts',
      ours: ['human'],
      theirs: ['agent'],
    });
    const mergedDoc = merged.body.merged as { nodes: { id: string; parameters: unknown }[] };
    expect(mergedDoc.nodes.find((n) => n.id === 'announce')?.parameters).toMatchObject({
      texts: ['human'],
    });

    // Re-submitting that auto-resolved document against the stale base is refused again: an
    // unresolved field conflict is an error, never a silent auto-land.
    const resubmitted = await refusal({
      workflow_id: workflowId,
      workflow_ir: mergedDoc,
      branch: 'main',
      base_version_id: v1Id,
    });
    expect(resubmitted).toContain('moved on');
    expect(await versionCount(workflowId)).toBe(2);

    // Resolved field-by-field and re-based, the commit lands — v3, with the live pointer still on v1.
    const landed = await commit({
      workflow_id: workflowId,
      workflow_ir: ir(['human', 'agent']),
      branch: 'main',
      base_version_id: v2Id,
    });
    expect(landed.version_number).toBe(3);
    expect(landed.is_live).toBe(false);
    expect(await liveVersionId(workflowId)).toBe(v1Id);
  });

  it('mints nothing when the document is content-equal to the head', async () => {
    const { workflowId, v1Id } = await seed('commit no-diff', ir(['v1']));

    const result = await commit({
      workflow_id: workflowId,
      workflow_ir: ir(['v1']),
      branch: 'main',
      base_version_id: v1Id,
    });

    expect(result.no_changes).toBe(true);
    expect(result.version_id).toBe(v1Id);
    expect(result.version_number).toBe(1);
    expect(await versionCount(workflowId)).toBe(1);
  });
});
