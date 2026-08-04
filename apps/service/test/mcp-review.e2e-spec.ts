import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { REVIEW_ALREADY_OPEN } from '../src/reviews/reviews.service';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const FRONTEND_URL = 'https://app.orchestr.test';

interface DiffSummary {
  from_version_id: string;
  to_version_id: string;
  summary: string;
  node_changes: Array<{
    operation: string;
    node_id: string;
    node_name: string | null;
    path: string | null;
  }>;
  edge_changes: Array<{
    operation: string;
    source_node_id: string;
    source_port: number;
    target_node_id: string;
    target_port: number;
    port_type: string;
  }>;
  settings_changes: Array<{ path: string | null }>;
  renames: Array<{ old_name: string; new_name: string }>;
  renames_are_presentational: boolean;
}

interface Proposal {
  review_id: string;
  review_url: string;
  title: string;
  status: string;
  source_branch: string;
  target_branch: string;
  diff_summary: DiffSummary | null;
  mergeable: boolean | 'unknown';
}

/** Every branch row's head, plus the total version count — the two things a probe must never move. */
interface RepoState {
  versions: number;
  heads: Array<{ name: string; head_version_id: string | null }>;
  tags: Array<{ tag: string; version_id: string; branch_id: string | null }>;
}

/** `orchestr_open_review` through the real MCP client — an agent's terminal move (ADR 0052). */
describe('orchestr_open_review (e2e, real MCP client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;

  const userId = randomUUID();
  const foreignUserId = randomUUID();
  const orgId = randomUUID();
  const authorKey = 'ork_review_author_key_eeeeeeeeeeee';
  const deployKey = 'ork_review_deploy_key_ffffffffffff';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const wfId = randomUUID();
  const foreignWfId = randomUUID();
  const mainId = randomUUID();
  const cleanId = randomUUID();
  const conflictId = randomUUID();
  const mainV1 = randomUUID();
  const mainV2 = randomUUID();
  const cleanV1 = randomUUID();
  const conflictV1 = randomUUID();

  const mainEdge = {
    id: 'e1',
    source_node_id: 'trigger',
    source_port: 0,
    target_node_id: 'send',
    target_port: 0,
    port_type: 'main',
  };
  // Same id and endpoints as the main edge — only `port_type` distinguishes it (invariant #13).
  const errorEdge = { ...mainEdge, port_type: 'error' };

  const ir = (subject: string, body: string, withErrorEdge = false): Record<string, unknown> => ({
    version: '1',
    name: 'review flow',
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
        parameters: { subject, body },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: withErrorEdge ? [mainEdge, errorEdge] : [mainEdge],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'orchestr-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${authorKey}` } },
      }),
    );
    return client;
  }

  async function openReview(args: Record<string, unknown>): Promise<Proposal> {
    const client = await connect();
    try {
      // List first, so the client validates the result against the schema the server advertises.
      await client.listTools();
      const result = await client.callTool({ name: 'orchestr_open_review', arguments: args });
      expect(result.isError).toBeFalsy();
      return result.structuredContent as Proposal;
    } finally {
      await client.close();
    }
  }

  async function refusal(args: Record<string, unknown>): Promise<{ text: string; error: string }> {
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'orchestr_open_review', arguments: args });
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { error?: string };
      return {
        text: (result.content as { type: string; text: string }[])[0]?.text ?? '',
        error: structured?.error ?? '',
      };
    } finally {
      await client.close();
    }
  }

  async function repoState(): Promise<RepoState> {
    const versions = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_versions WHERE workflow_id = $1`,
      [wfId],
    );
    const heads = await db.query<{ name: string; head_version_id: string | null }>(
      `SELECT name, head_version_id FROM workflow_branches WHERE workflow_id = $1 ORDER BY name`,
      [wfId],
    );
    const tags = await db.query<{ tag: string; version_id: string; branch_id: string | null }>(
      `SELECT tag, version_id, branch_id FROM workflow_version_tags WHERE workflow_id = $1
        ORDER BY tag, branch_id`,
      [wfId],
    );
    return {
      versions: Number(versions.rows[0]?.count ?? '0'),
      heads: heads.rows,
      tags: tags.rows,
    };
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'review@e2e.local', 'Review Author', now(), now()),
              ($2, 'foreign@e2e.local', 'Foreign User', now(), now())`,
      [userId, foreignUserId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Review Workspace', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'author', $3, 'ork_review_a',
               '["workflow:read","workflow:write"]', now()),
              (gen_random_uuid(), $1, $2, 'deploy', $4, 'ork_review_d',
               '["workflow:read","workflow:write","workflow:deploy"]', now())`,
      [userId, orgId, hash(authorKey), hash(deployKey)],
    );

    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'Review Flow',  'generated', $3, $4, now(), now()),
              ($2, 'Foreign Flow', 'generated', $5, NULL, now(), now())`,
      [wfId, foreignWfId, userId, orgId, foreignUserId],
    );

    const foreignMainId = randomUUID();
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name, is_default, is_protected, created_at)
       VALUES ($1, $5, 'main',     true,  false, now()),
              ($2, $5, 'clean',    false, false, now()),
              ($3, $5, 'conflict', false, false, now()),
              ($4, $6, 'main',     true,  false, now())`,
      [mainId, cleanId, conflictId, foreignMainId, wfId, foreignWfId],
    );

    // Fork point main@v1. main then edits `subject`; `clean` edits only `body` (and adds an error
    // edge); `conflict` edits the SAME `subject` field — field-level conflicts, invariant #5.
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, commit_message, branch_id, parent_id, created_at)
       VALUES ($1, $9,  1, $2, 'base',           $10, NULL, now() - interval '4 hour'),
              ($3, $9,  2, $4, 'main edits subject', $10, $1, now() - interval '3 hour'),
              ($5, $9,  1, $6, 'clean edits body',   $11, $1, now() - interval '2 hour'),
              ($7, $9,  1, $8, 'conflicting subject', $12, $1, now() - interval '1 hour')`,
      [
        mainV1,
        JSON.stringify(ir('base', 'base body')),
        mainV2,
        JSON.stringify(ir('main change', 'base body')),
        cleanV1,
        JSON.stringify(ir('base', 'clean body', true)),
        conflictV1,
        JSON.stringify(ir('conflicting change', 'base body')),
        wfId,
        mainId,
        cleanId,
        conflictId,
      ],
    );
    await db.query(
      `UPDATE workflow_branches SET head_version_id = CASE id
         WHEN $1 THEN $4::uuid WHEN $2 THEN $5::uuid ELSE $6::uuid END
        WHERE id IN ($1, $2, $3)`,
      [mainId, cleanId, conflictId, mainV2, cleanV1, conflictV1],
    );
    await db.query(
      `INSERT INTO workflow_version_tags (id, workflow_id, version_id, tag, branch_id, activated, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'latest', $3, true, now())`,
      [wfId, mainV2, mainId],
    );
    await db.query(`UPDATE workflows SET default_branch_id = $1 WHERE id = $2`, [mainId, wfId]);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.FRONTEND_URL = FRONTEND_URL;

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
    delete process.env.FRONTEND_URL;
  });

  it('is listed for a workflow:write key', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('orchestr_open_review');
    await client.close();
  });

  let cleanReviewId = '';
  let cleanReviewUrl = '';
  let conflictReviewId = '';

  it('opens a review whose diff_summary is the real field-level change between the two heads', async () => {
    const before = await repoState();

    const proposal = await openReview({
      workflow_id: wfId,
      source_branch: 'clean',
      target_branch: 'main',
      title: 'Reword the body',
      description: 'Only the body copy changes.',
    });
    cleanReviewId = proposal.review_id;
    cleanReviewUrl = proposal.review_url;

    expect(proposal).toMatchObject({
      title: 'Reword the body',
      status: 'open',
      source_branch: 'clean',
      target_branch: 'main',
    });

    const diff = proposal.diff_summary;
    expect(diff).not.toBeNull();
    // from = the target head a reviewer holds against; to = what the branch proposes.
    expect(diff?.from_version_id).toBe(mainV2);
    expect(diff?.to_version_id).toBe(cleanV1);
    expect(diff?.node_changes).toEqual([
      { operation: 'modify_node', node_id: 'send', node_name: 'Send Email', path: 'parameters.body' },
      { operation: 'modify_node', node_id: 'send', node_name: 'Send Email', path: 'parameters.subject' },
    ]);
    expect(diff?.edge_changes).toEqual([
      {
        operation: 'add_edge',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'send',
        target_port: 0,
        port_type: 'error',
      },
    ]);
    expect(diff?.settings_changes).toEqual([]);
    expect(diff?.renames).toEqual([]);
    expect(diff?.renames_are_presentational).toBe(true);
    expect(diff?.summary).toContain('2 node modification(s)');
    expect(diff?.summary).toContain('1 connection change(s)');

    // `clean` touched only `body`, `main` only `subject`: different (node_id, path) keys merge clean.
    expect(proposal.mergeable).toBe(true);

    // Nothing minted, nothing moved — opening a review is not a commit.
    expect(await repoState()).toEqual(before);
  });

  it('reports a genuinely conflicting pair as NOT mergeable, without merging anything', async () => {
    const before = await repoState();

    const proposal = await openReview({
      workflow_id: wfId,
      source_branch: 'conflict',
      target_branch: 'main',
      title: 'Reword the subject',
    });

    conflictReviewId = proposal.review_id;
    expect(proposal.mergeable).toBe(false);
    // Both branches changed `parameters.subject` off the same ancestor.
    expect(proposal.diff_summary?.node_changes).toEqual([
      { operation: 'modify_node', node_id: 'send', node_name: 'Send Email', path: 'parameters.subject' },
    ]);

    const after = await repoState();
    expect(after).toEqual(before);
    expect(after.versions).toBe(4);
    expect(after.heads).toEqual([
      { name: 'clean', head_version_id: cleanV1 },
      { name: 'conflict', head_version_id: conflictV1 },
      { name: 'main', head_version_id: mainV2 },
    ]);
    expect(after.tags).toEqual([{ tag: 'latest', version_id: mainV2, branch_id: mainId }]);
  });

  it('a duplicate review returns the machine code AND the id of the review already open', async () => {
    const before = await repoState();

    const { text, error } = await refusal({
      workflow_id: wfId,
      source_branch: 'clean',
      target_branch: 'main',
      title: 'Reword the body, again',
    });

    // The code is a published contract, so its literal value is pinned here, not just referenced.
    expect(REVIEW_ALREADY_OPEN).toBe('review_already_open');
    expect(text).toContain(REVIEW_ALREADY_OPEN);
    expect(text).toContain(cleanReviewId);
    expect(error).toContain(REVIEW_ALREADY_OPEN);
    expect(error).toContain(cleanReviewId);

    // One review, not two — the retry loop this error exists to break.
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_reviews
        WHERE workflow_id = $1 AND source_branch_id = $2 AND target_branch_id = $3`,
      [wfId, cleanId, mainId],
    );
    expect(rows.rows[0]?.count).toBe('1');
    expect(await repoState()).toEqual(before);
  });

  it('the review is visible to a human at the API behind the returned URL', async () => {
    const url = new URL(cleanReviewUrl);
    expect(url.origin).toBe(FRONTEND_URL);
    expect(url.pathname).toBe(`/workflows/${wfId}/overview`);
    expect(url.searchParams.get('review')).toBe(cleanReviewId);
    expect(url.searchParams.get('branch')).toBe('clean');

    const list = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/reviews`)
      .set('Authorization', `Bearer ${authorKey}`)
      .expect(200);
    expect(list.body.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cleanReviewId,
          title: 'Reword the body',
          status: 'open',
          source_branch: 'clean',
          target_branch: 'main',
          author_name: 'Review Author',
        }),
      ]),
    );

    const detail = await request(app.getHttpServer())
      .get(`/api/workflows/${wfId}/reviews/${cleanReviewId}`)
      .set('Authorization', `Bearer ${authorKey}`)
      .expect(200);
    expect(detail.body.description).toBe('Only the body copy changes.');
  });

  it('no MCP tool can merge the review it opened', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.some((t) => /merge/i.test(t.name))).toBe(false);
  });

  it('a workflow the key cannot write is refused BEFORE a review row is created', async () => {
    const { text } = await refusal({
      workflow_id: foreignWfId,
      source_branch: 'main',
      target_branch: 'main',
      title: 'Not mine',
    });
    expect(text).toContain('Not authorised');

    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_reviews WHERE workflow_id = $1`,
      [foreignWfId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('an unknown branch is refused, naming the branch', async () => {
    const { text } = await refusal({
      workflow_id: wfId,
      source_branch: 'nope',
      target_branch: 'main',
      title: 'Missing branch',
    });
    expect(text).toContain('nope');
    expect(text).toContain('not found');
  });

  // Last: the real merge mutates. Runs on the deploy key, because no MCP-issuable scope reaches it.
  it('the probe told the truth — the real merge reaches the same verdict on both pairs', async () => {
    const conflicted = await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/reviews/${conflictReviewId}/merge`)
      .set('Authorization', `Bearer ${deployKey}`)
      .send({})
      .expect(201);
    expect(conflicted.body.status).toBe('conflicts');
    expect(conflicted.body.merged_version_id).toBeNull();
    expect(conflicted.body.conflicts).toEqual([
      expect.objectContaining({ node_id: 'send', kind: 'field', field_path: 'parameters.subject' }),
    ]);

    const merged = await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/reviews/${cleanReviewId}/merge`)
      .set('Authorization', `Bearer ${deployKey}`)
      .send({})
      .expect(201);
    expect(merged.body.status).toBe('merged');
    expect(merged.body.merged_version_id).toBeTruthy();

    // The merge the agent could not perform is what moves the head the probe left alone.
    const after = await repoState();
    expect(after.versions).toBe(5);
    expect(after.heads).toContainEqual({ name: 'main', head_version_id: merged.body.merged_version_id });
  });

  it('the merge route refuses the key the agent holds', async () => {
    await request(app.getHttpServer())
      .post(`/api/workflows/${wfId}/reviews/${conflictReviewId}/merge`)
      .set('Authorization', `Bearer ${authorKey}`)
      .send({})
      .expect(403);
  });
});
