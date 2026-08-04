import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

interface SearchHit {
  type: string;
  name: string;
  kind: string;
  category: string;
  description: string;
  rail: string;
  requires_connection: boolean;
}

interface SearchResult {
  results: SearchHit[];
  next_cursor?: string;
}

interface DescribeResult {
  type: string;
  name: string;
  kind: string;
  rail: string;
  auth: { scheme: string; required: boolean };
  parameters: Record<string, { required?: boolean }>;
  example_config: Record<string, unknown>;
  one_of_constraints: Array<{ label: string; oneOf: string[] }>;
  honesty_warnings: string[];
  schema_truncated?: { omitted_properties: string[]; omitted_count: number; note: string };
}

/** The catalog half of the MCP surface (ADR 0052), driven by the real MCP client. */
describe('Platform MCP catalog tools (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;
  let client: Client;

  const userId = randomUUID();
  const orgId = randomUUID();
  const readKey = 'ork_mcp_catalog_key_dddddddddddddd';

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return result.structuredContent as T;
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'mcp-catalog@e2e.local', 'MCP Catalog Owner', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'MCP Catalog Workspace', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'read', $3, 'ork_mcp_cata', '["workflow:read"]', now())`,
      [userId, orgId, createHash('sha256').update(readKey, 'utf8').digest('hex')],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    // Composio trigger projection OFF (ADR 0046): the catalog stays deterministic and makes no live call.
    process.env.COMPOSIO_API_KEY = '';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    client = new Client({ name: 'orchestr-catalog-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${readKey}` } },
      }),
    );
  }, 40_000);

  afterAll(async () => {
    await client.close();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('kind:"trigger" returns real app triggers, not just the native control kinds', async () => {
    const found = await call<SearchResult>('orchestr_search_actions', {
      query: 'new github push',
      kind: 'trigger',
      limit: 10,
    });

    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.every((hit) => hit.kind === 'trigger')).toBe(true);
    expect(found.results.map((hit) => hit.type)).toContain('github.new_push');
    // The defect this closes: before the one-source fix only orchestr:* kinds were reachable.
    expect(found.results.some((hit) => hit.rail === 'sdk')).toBe(true);

    const polling = await call<SearchResult>('orchestr_search_actions', {
      query: 'rss feed item',
      kind: 'trigger',
      limit: 5,
    });
    expect(polling.results.map((hit) => hit.type)).toContain('rss.new_item');
    expect(polling.results.find((hit) => hit.type === 'rss.new_item')?.requires_connection).toBe(false);
  });

  it('kind:"action" excludes triggers', async () => {
    const found = await call<SearchResult>('orchestr_search_actions', {
      query: 'new github push',
      kind: 'action',
      limit: 10,
    });

    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.some((hit) => hit.kind === 'trigger')).toBe(false);
    const types = found.results.map((hit) => hit.type);
    expect(types).not.toContain('github.new_push');
    expect(types).not.toContain('rss.new_item');
  });

  it('kind:"any" reaches both halves and pages with an opaque cursor', async () => {
    const first = await call<SearchResult>('orchestr_search_actions', {
      query: 'slack channel message',
      kind: 'any',
      limit: 6,
    });
    const kinds = new Set(first.results.map((hit) => hit.kind));
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('trigger')).toBe(true);
    expect(first.next_cursor).toBeDefined();

    const second = await call<SearchResult>('orchestr_search_actions', {
      query: 'slack channel message',
      kind: 'any',
      limit: 6,
      cursor: first.next_cursor,
    });
    const firstTypes = new Set(first.results.map((hit) => hit.type));
    expect(second.results.some((hit) => firstTypes.has(hit.type))).toBe(false);

    // A cursor is bound to the search that minted it — reusing it elsewhere would skip rows.
    const wrong = await client.callTool({
      name: 'orchestr_search_actions',
      arguments: { query: 'a different query', kind: 'any', limit: 6, cursor: first.next_cursor },
    });
    expect(wrong.isError).toBe(true);
  });

  it('describes an SDK action with its schema, auth scheme and a runnable example config', async () => {
    const entry = await call<DescribeResult>('orchestr_describe_action', {
      type: 'slack.send_channel_message',
    });

    expect(entry).toMatchObject({ kind: 'action', rail: 'sdk' });
    expect(entry.auth).toEqual({ scheme: 'oauth2', required: true });
    expect(entry.parameters.channel).toBeDefined();
    expect(entry.parameters.channel?.required).toBe(true);
    expect(Object.keys(entry.example_config)).toContain('channel');
    expect(entry.schema_truncated).toBeUndefined();
  });

  it('describes a Composio action, naming the managed scheme and the one-of its schema under-declares', async () => {
    const entry = await call<DescribeResult>('orchestr_describe_action', {
      type: 'asana.get_team_memberships',
    });

    expect(entry).toMatchObject({ kind: 'action', rail: 'composio' });
    expect(entry.auth).toEqual({ scheme: 'managed', required: true });
    expect(Object.keys(entry.parameters).length).toBeGreaterThan(0);
    expect(entry.one_of_constraints[0]?.oneOf).toEqual(['team', 'workspace', 'user']);
    expect(entry.honesty_warnings.join(' ')).toMatch(/team, workspace, user/);
  });

  it('resolves a trigger type as well as an action type', async () => {
    const entry = await call<DescribeResult>('orchestr_describe_action', { type: 'github.new_push' });

    expect(entry).toMatchObject({ type: 'github.new_push', kind: 'trigger', rail: 'sdk' });
    expect(entry.auth.required).toBe(true);
    expect(entry.parameters.owner).toBeDefined();
    expect(entry.parameters.repo).toBeDefined();
  });

  it('trims an oversized schema, names what it omitted, and hands those back on request', async () => {
    const entry = await call<DescribeResult>('orchestr_describe_action', {
      type: 'intercom.update_an_article',
    });

    const kept = Object.keys(entry.parameters);
    expect(entry.schema_truncated).toBeDefined();
    expect(entry.schema_truncated?.omitted_properties.length).toBeGreaterThan(0);
    expect(entry.schema_truncated?.omitted_count).toBeGreaterThan(kept.length);
    // Trimmed, not emptied — and the required parameter always survives.
    expect(kept.length).toBeGreaterThan(0);
    expect(entry.parameters.id).toBeDefined();
    // The envelope's own 15 KB cap must never be what trims this result.
    expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThan(15_000);

    const name = entry.schema_truncated?.omitted_properties[0] as string;
    const requested = await call<DescribeResult>('orchestr_describe_action', {
      type: 'intercom.update_an_article',
      include_properties: [name],
    });
    expect(Object.keys(requested.parameters)).toEqual([name]);
  });

  it('an unknown type fails with an error that names the search tool', async () => {
    const result = await client.callTool({
      name: 'orchestr_describe_action',
      arguments: { type: 'slack.summon_dragon' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toMatch(/orchestr_search_actions/);
  });
});
