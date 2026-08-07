import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { fernetEncrypt } from '../src/common/crypto/fernet';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ISSUER = 'https://idp.mcp-runs.local';

/** Secrets seeded into the connection store; NONE may ever appear in a tool result. */
const BYO_CLIENT_SECRET = 'byo-client-secret-must-never-ship';
const BYO_ACCESS_TOKEN = 'byo-access-token-must-never-ship';
const TOKEN_CREDENTIAL = 'raw-token-must-never-ship';
const MANAGED_ACCOUNT_ID = 'ca_managed_account_must_never_ship';

/** A one-node workflow whose only output is `marker` — a stand-in for a verbatim provider payload. */
function markerIr(name: string, marker: string): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: [marker], separator: '' },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** Parks on `orchestr:wait_for_event` so the run shows up on the approvals inbox. */
function approvalIr(topic: string): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'mcp approval flow',
    description: '',
    nodes: [
      {
        id: 'approval',
        name: 'Approval',
        node_type: 'orchestr:wait_for_event',
        type_version: 1,
        parameters: { topic, timeout_ms: 20_000 },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/**
 * `orchestr_get_run` + `orchestr_list_connections` through the real MCP client (ADR 0052), with BOTH
 * credential kinds live: `ork_` keys and OIDC sessions, so the api-key narrowing is provable against
 * the session behaviour it must not regress.
 */
describe('Platform MCP: runs + connections (e2e, real client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;
  let jwks: Server;
  let privateKey: KeyLike;

  const userA = randomUUID();
  const userB = randomUUID();
  const personalA = randomUUID();
  const personalB = randomUUID();
  const orgId = randomUUID();

  const keyA = 'ork_agent_key_aaaaaaaaaaaaaaaaaaaaaa';
  const readOnlyKey = 'ork_read_key_bbbbbbbbbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const connManaged = randomUUID();
  const connByo = randomUUID();
  const connToken = randomUUID();
  const connCluster = randomUUID();
  const connOfB = randomUUID();

  const markerA = `PAYLOAD-A-${randomUUID()}`;
  const markerB = `PAYLOAD-B-${randomUUID()}`;
  const runIdA = 'mcp-run-a';
  const runIdB = 'mcp-run-b';
  const refA = (): string => `${userA}:${runIdA}`;
  const refB = (): string => `${userB}:${runIdB}`;

  let sessionA = '';
  let sessionB = '';
  let workflowId = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const asSessionA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${sessionA}`);
  const asSessionB = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${sessionB}`);

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'orchestr-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  /** One tool call on a fresh connection — v1 keeps no per-connection state, so this is the honest shape. */
  async function call(key: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await connect(key);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
    }
  }

  const textOf = (result: CallToolResult): string =>
    (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');

  async function seedUsers(): Promise<void> {
    await db.query(
      `INSERT INTO users (id, email, name, clerk_user_id, created_at, updated_at)
       VALUES ($1, 'owner-a@mcp.local', 'Owner A', 'oidc-a', now(), now()),
              ($2, 'member-b@mcp.local', 'Member B', 'oidc-b', now(), now())`,
      [userA, userB],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner A', true, now(), now()),
              ($2, 'Member B', true, now(), now()),
              ($3, 'MCP Runs Workspace', false, now(), now())`,
      [personalA, personalB, orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()),
              (gen_random_uuid(), $3, $4, 'owner', now()),
              (gen_random_uuid(), $5, $2, 'owner', now()),
              (gen_random_uuid(), $5, $4, 'member', now())`,
      [personalA, userA, personalB, userB, orgId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'agent', $3, $4, $5::json, now()),
              (gen_random_uuid(), $1, $2, 'wf-read', $6, $7, $8::json, now())`,
      [
        userA,
        orgId,
        hash(keyA),
        keyA.slice(0, 12),
        JSON.stringify(['workflow:read', 'connection:read']),
        hash(readOnlyKey),
        readOnlyKey.slice(0, 12),
        JSON.stringify(['workflow:read']),
      ],
    );
  }

  async function seedConnections(): Promise<void> {
    const enc = (plaintext: string): string => fernetEncrypt(TEST_FERNET_KEY, plaintext);
    const byoClient = JSON.stringify({
      clientId: 'gitlab-client-id',
      clientSecret: BYO_CLIENT_SECRET,
      authUrl: 'https://gitlab.example.com/oauth/authorize',
      tokenUrl: 'https://gitlab.example.com/oauth/token',
      scopes: ['api'],
      usePkce: true,
    });
    await db.query(
      `INSERT INTO connections (id, user_id, provider, display_name, auth_type, credential, oauth_client,
                                created_at, status, org_id, environment)
       VALUES ($1, $6, 'slack', 'Owner A slack', 'managed', $2, NULL, now(), 'active', NULL, NULL),
              ($3, $6, 'gitlab', NULL, 'oauth2', $4, $5, now() - interval '1 minute', 'active', NULL, NULL),
              ($7, $6, 'My Custom App', NULL, 'token', $8, NULL, now() - interval '2 minutes', 'failed', NULL, NULL)`,
      [
        connManaged,
        enc(JSON.stringify({ connected_account_id: MANAGED_ACCOUNT_ID })),
        connByo,
        enc(JSON.stringify({ access_token: BYO_ACCESS_TOKEN })),
        enc(byoClient),
        userA,
        connToken,
        enc(JSON.stringify(TOKEN_CREDENTIAL)),
      ],
    );
    // Excluded from the personal surface: an org CLUSTER row of A's, and a row of another member's.
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
       VALUES ($1, $2, 'notion', 'managed', 'enc', now(), 'active', $3, 'prod'),
              ($4, $5, 'linear', 'managed', 'enc', now(), 'active', NULL, NULL)`,
      [connCluster, userA, orgId, connOfB, userB],
    );
  }

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    privateKey = priv;
    const jwk = { ...(await exportJWK(publicKey)), kid: 'mcp-kid', alg: 'RS256', use: 'sig' };
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));

    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();
    await seedUsers();
    await seedConnections();

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;

    const sign = (subject: string): Promise<string> =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'mcp-kid' })
        .setIssuer(ISSUER)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('30m')
        .sign(privateKey);
    sessionA = await sign('oidc-a');
    sessionB = await sign('oidc-b');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // One completed run per member, both against a workflow in the SHARED org.
    const deployed = await asSessionB(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({ workflow_json: markerIr('mcp run workflow', markerB) }),
    ).expect(201);
    workflowId = deployed.body.workflow_id as string;

    await asSessionB(
      http()
        .post('/api/runs/from-ir')
        .set('X-Org-Id', orgId)
        .send({
          workflow_ir: markerIr('mcp run workflow', markerB),
          workflow_id: workflowId,
          run_id: runIdB,
        }),
    ).expect(201);
    await asSessionA(
      http()
        .post('/api/runs/from-ir')
        .set('X-Org-Id', orgId)
        .send({
          workflow_ir: markerIr('mcp run workflow', markerA),
          workflow_id: workflowId,
          run_id: runIdA,
        }),
    ).expect(201);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => jwks.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.OIDC_ISSUER = '';
    process.env.OIDC_JWKS_URL = '';
  });

  // ── The finding: org-wide run reach is a SESSION property, never a token's ──

  it("an api_key cannot read another org member's run, over MCP or over REST", async () => {
    const result = await call(keyA, 'orchestr_get_run', { run_id: refB() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found/i);
    expect(textOf(result)).not.toContain(markerB);

    // The same refusal on the REST route the same token bears — the narrowing is in the read
    // path, not in the MCP layer a token walks around (ADR 0052 §4).
    const rest = await http()
      .get(`/api/runs/${encodeURIComponent(refB())}`)
      .set('Authorization', `Bearer ${keyA}`)
      .expect(200);
    expect(rest.body.status).toBe('not_found');
    expect(rest.body.steps ?? []).toEqual([]);
    expect(JSON.stringify(rest.body)).not.toContain(markerB);
  });

  it("the same run IS readable by its owner's session AND by another member's session (inbox intact)", async () => {
    const owner = await asSessionB(
      http()
        .get(`/api/runs/${encodeURIComponent(refB())}`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    expect(owner.body.status).toBe('completed');

    // Org-wide session reach — the human approvals inbox — must not have been narrowed.
    const otherMember = await asSessionA(
      http()
        .get(`/api/runs/${encodeURIComponent(refB())}`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    expect(otherMember.body.status).toBe('completed');
    expect((otherMember.body.steps as unknown[]).length).toBe(1);
  });

  it('an api_key reads its OWN run in full', async () => {
    const result = await call(keyA, 'orchestr_get_run', { run_id: refA(), include_step_outputs: true });
    expect(result.isError).toBeFalsy();
    const run = result.structuredContent as Record<string, unknown>;
    expect(run).toMatchObject({ run_id: refA(), status: 'completed', failed_node_id: null });
    expect((run.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      node_id: 'announce',
      status: 'completed',
      output: markerA,
    });
  });

  it('the approvals inbox is org-wide for a session and own-runs-only for a key', async () => {
    const topic = 'approve';
    const parked = asSessionB(
      http()
        .post('/api/runs/from-ir')
        .set('X-Org-Id', orgId)
        .send({ workflow_ir: approvalIr(topic), workflow_id: workflowId, run_id: 'mcp-parked' }),
    ).then((r) => r);

    let seenByA: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !seenByA; i++) {
      const res = await asSessionA(http().get('/api/runs/waiting').set('X-Org-Id', orgId)).expect(200);
      seenByA = (res.body.runs as Array<Record<string, unknown>>).find((r) => r.run_id === 'mcp-parked');
      if (!seenByA) await new Promise((r) => setTimeout(r, 50));
    }
    expect(seenByA).toBeDefined();

    // The same org, the same user, a bearer credential: B's parked run (and B's email) stay invisible.
    const viaKey = await http().get('/api/runs/waiting').set('Authorization', `Bearer ${keyA}`).expect(200);
    expect((viaKey.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).not.toContain('mcp-parked');
    expect(JSON.stringify(viaKey.body)).not.toContain('member-b@mcp.local');

    // A session member resumes another member's run, and the decision is attributed to the approver.
    const ref = encodeURIComponent(seenByA!.id as string);
    await asSessionA(
      http()
        .post(`/api/runs/${ref}/events`)
        .set('X-Org-Id', orgId)
        .send({ topic, payload: { decision: 'approved' } }),
    ).expect(200);
    expect((await parked).status).toBe(201);

    const detail = await asSessionA(http().get(`/api/runs/${ref}`).set('X-Org-Id', orgId)).expect(200);
    expect(detail.body.decided_by?.id).toBe(userA);
    expect(detail.body.decided_at).toBeTruthy();
  }, 40_000);

  // ── include_step_outputs is a read option, not a post-hoc filter ──

  it('include_step_outputs defaults to false and the payloads are ABSENT, not blanked', async () => {
    for (const args of [{ run_id: refA() }, { run_id: refA(), include_step_outputs: false }]) {
      const result = await call(keyA, 'orchestr_get_run', args);
      expect(result.isError).toBeFalsy();
      const run = result.structuredContent as Record<string, unknown>;
      const step = (run.steps as Array<Record<string, unknown>>)[0]!;

      expect(run.step_outputs_included).toBe(false);
      expect('outputs' in run).toBe(false);
      expect('output' in step).toBe(false);
      expect('output_preview' in step).toBe(false);
      // Nothing of the payload survives anywhere in the serialized result — not in a preview either.
      expect(JSON.stringify(result)).not.toContain(markerA);
      // The log itself is still useful without them.
      expect(step).toMatchObject({ node_id: 'announce', status: 'completed', attempts: 1 });
    }
  });

  it('include_step_outputs: true returns the payloads', async () => {
    const result = await call(keyA, 'orchestr_get_run', { run_id: refA(), include_step_outputs: true });
    const run = result.structuredContent as Record<string, unknown>;
    expect(run.step_outputs_included).toBe(true);
    expect(run.outputs).toEqual({ announce: markerA });
    expect(JSON.stringify(result)).toContain(markerA);
  });

  it('the runs panel is unchanged: the REST read still carries output + output_preview', async () => {
    const res = await asSessionA(
      http()
        .get(`/api/runs/${encodeURIComponent(refA())}`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    const step = (res.body.steps as Array<Record<string, unknown>>)[0]!;
    expect(step.output).toBe(markerA);
    expect(step.output_preview).toBe(JSON.stringify(markerA));
  });

  // ── orchestr_list_connections: ids and status, never credential material ──

  it('lists only the caller’s own connections as authoring references, with no credential material', async () => {
    const result = await call(keyA, 'orchestr_list_connections', { limit: 50 });
    expect(result.isError).toBeFalsy();
    const connections = (result.structuredContent as { connections: Array<Record<string, unknown>> })
      .connections;

    expect(connections.map((c) => c.id).sort()).toEqual([connManaged, connByo, connToken].sort());
    expect(connections).toContainEqual({
      id: connManaged,
      provider: 'slack',
      app_slug: 'slack',
      kind: 'managed',
      status: 'active',
    });
    expect(connections).toContainEqual({
      id: connByo,
      provider: 'gitlab',
      app_slug: 'gitlab',
      kind: 'byo',
      status: 'active',
      host: 'gitlab.example.com',
    });
    // A provider that is not an addressable `<app>` slug says so rather than implying an action id.
    expect(connections).toContainEqual({
      id: connToken,
      provider: 'My Custom App',
      app_slug: null,
      kind: 'byo',
      status: 'failed',
    });

    const serialized = JSON.stringify(result);
    for (const secret of [
      BYO_CLIENT_SECRET,
      BYO_ACCESS_TOKEN,
      TOKEN_CREDENTIAL,
      MANAGED_ACCOUNT_ID,
      'gitlab-client-id',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Not another member's row, not an org cluster row, and no display name or owner identity.
    expect(serialized).not.toContain(connOfB);
    expect(serialized).not.toContain(connCluster);
    expect(serialized).not.toContain('Owner A slack');
    expect(serialized).not.toContain('owner-a@mcp.local');
  });

  it('pages with limit + an opaque cursor, and refuses a cursor it did not issue', async () => {
    const first = await call(keyA, 'orchestr_list_connections', { limit: 2 });
    const page1 = first.structuredContent as { connections: Array<{ id: string }>; next_cursor: string };
    expect(page1.connections).toHaveLength(2);
    expect(page1.next_cursor).toEqual(expect.any(String));

    const second = await call(keyA, 'orchestr_list_connections', { limit: 2, cursor: page1.next_cursor });
    const page2 = second.structuredContent as {
      connections: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(page2.connections).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    expect(page1.connections.map((c) => c.id)).not.toContain(page2.connections[0]!.id);

    const bad = await call(keyA, 'orchestr_list_connections', { cursor: 'not-a-cursor' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/cursor/i);
  });

  it('`query` filters by app', async () => {
    const result = await call(keyA, 'orchestr_list_connections', { query: 'sla' });
    const { connections } = result.structuredContent as { connections: Array<{ id: string }> };
    expect(connections.map((c) => c.id)).toEqual([connManaged]);
  });

  it('a key without connection:read neither sees nor may call the tool', async () => {
    const client = await connect(readOnlyKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('orchestr_get_run');
    expect(tools.map((t) => t.name)).not.toContain('orchestr_list_connections');
    await expect(client.callTool({ name: 'orchestr_list_connections', arguments: {} })).rejects.toThrow();
    await client.close();
  });
});
