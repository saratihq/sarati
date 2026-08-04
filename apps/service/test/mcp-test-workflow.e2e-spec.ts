import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

interface ToolCall {
  ok: boolean;
  data: Record<string, unknown>;
  text: string;
}

/** ADR 0052 tool 15: dry by default, and firing for real needs scope AND consent for THIS document. */
describe('orchestr_test_workflow (e2e, real MCP client, isolated DB)', () => {
  let app: INestApplication;
  let db: PgClient;
  let baseUrl: string;
  let hitUrl: string;
  let hitServer: Server;
  let posts = 0;

  const userId = randomUUID();
  const orgId = randomUUID();
  const dryKey = 'ork_tw_dry_key_aaaaaaaaaaaaaaaaaaaa';
  const liveKey = 'ork_tw_live_key_bbbbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const doc = (text: string): Record<string, unknown> => ({
    version: '1.0',
    name: 'test rail',
    nodes: [
      {
        id: 'shout',
        name: 'Shout',
        node_type: 'http.send_request',
        type_version: 1,
        parameters: { method: 'POST', url: `${hitUrl}/write`, body: { text } },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  });

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'tw-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  async function call(key: string, args: Record<string, unknown>): Promise<ToolCall> {
    const client = await connect(key);
    try {
      const result = await client.callTool({ name: 'orchestr_test_workflow', arguments: args });
      return {
        ok: !result.isError,
        data: (result.structuredContent ?? {}) as Record<string, unknown>,
        text: ((result.content as { text?: string }[])[0]?.text ?? '').slice(0, 300),
      };
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new PgClient({ connectionString: e2eUrl });
    await db.connect();

    hitServer = createServer((req, res) => {
      if (req.url?.startsWith('/slow')) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"slow":true}');
        }, 1_200);
        return;
      }
      posts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"posted":true}');
    });
    await new Promise<void>((r) => hitServer.listen(0, '127.0.0.1', () => r()));
    hitUrl = `http://127.0.0.1:${(hitServer.address() as AddressInfo).port}`;

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1,'tw@e2e.local','TW',now(),now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1,'TW Org',false,now(),now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(),$1,$2,'owner',now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at)
       VALUES (gen_random_uuid(),$1,$2,'dry', $3,'ork_tw_dry_k',$5,now()),
              (gen_random_uuid(),$1,$2,'live',$4,'ork_tw_live_',$6,now())`,
      [
        userId,
        orgId,
        hash(dryKey),
        hash(liveKey),
        JSON.stringify(['workflow:read', 'run:dry']),
        JSON.stringify(['workflow:read', 'run:dry', 'run:execute']),
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
    await new Promise<void>((resolve, reject) => hitServer.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('defaults to a dry run: the write is stubbed and nothing leaves the building', async () => {
    posts = 0;
    const res = await call(dryKey, { workflow_ir: doc('dry') });

    expect(res.ok).toBe(true);
    expect(res.data.dry_run).toBe(true);
    expect(res.data.credentials_used).toBe('personal_pool');
    expect(res.data.status).toBe('completed');
    expect(posts).toBe(0);
    expect(typeof res.data.confirmation_token).toBe('string');
  });

  it('a preview-only key cannot fire for real, however it asks', async () => {
    posts = 0;
    const dry = await call(dryKey, { workflow_ir: doc('nope') });
    const live = await call(dryKey, {
      workflow_ir: doc('nope'),
      dry_run: false,
      confirmation_token: dry.data.confirmation_token,
    });

    expect(live.ok).toBe(false);
    expect(live.data.code).toBe('live_run_not_permitted');
    expect(posts).toBe(0);
  });

  it('an executing key still needs confirmation — a bare live run is refused', async () => {
    posts = 0;
    const res = await call(liveKey, { workflow_ir: doc('bare'), dry_run: false });

    expect(res.ok).toBe(false);
    expect(res.data.code).toBe('confirmation_required');
    expect(posts).toBe(0);
  });

  /** Otherwise an agent previews something harmless and fires something else. */
  it('refuses a token issued for a DIFFERENT document', async () => {
    posts = 0;
    const dry = await call(liveKey, { workflow_ir: doc('harmless') });
    const res = await call(liveKey, {
      workflow_ir: doc('dangerous'),
      dry_run: false,
      confirmation_token: dry.data.confirmation_token,
    });

    expect(res.ok).toBe(false);
    expect(res.data.code).toBe('confirmation_mismatch');
    expect(posts).toBe(0);
  });

  it('fires exactly once with the scope and a matching confirmation, and not twice on the same token', async () => {
    posts = 0;
    const dry = await call(liveKey, { workflow_ir: doc('for real') });
    const live = await call(liveKey, {
      workflow_ir: doc('for real'),
      dry_run: false,
      confirmation_token: dry.data.confirmation_token,
    });

    expect(live.ok).toBe(true);
    expect(live.data.dry_run).toBe(false);
    expect(posts).toBe(1);

    // The token is spent; replaying it cannot fire a second time.
    const replay = await call(liveKey, {
      workflow_ir: doc('for real'),
      dry_run: false,
      confirmation_token: dry.data.confirmation_token,
    });
    expect(replay.ok).toBe(false);
    expect(posts).toBe(1);
  });

  it('hands back a handle to poll when the run outlives the wait', async () => {
    // The stub server is what makes the run slow — a GET is not stubbed by a dry run (ADR 0041).
    const slow = {
      ...doc('slow'),
      nodes: [
        {
          id: 'wait',
          name: 'Wait',
          node_type: 'http.send_request',
          type_version: 1,
          parameters: { method: 'GET', url: `${hitUrl}/slow` },
          position: { x: 0, y: 0 },
          metadata: {},
        },
      ],
    };
    const res = await call(dryKey, { workflow_ir: slow, await_ms: 100 });

    if (!res.ok) throw new Error(`handle run failed: ${res.text}`);
    expect(res.data.status).toBe('running');
    expect(res.data.poll_with).toBe('orchestr_get_run');
    expect(typeof res.data.run_id).toBe('string');
  });

  it('refuses an ambiguous request rather than guessing which document to run', async () => {
    const res = await call(dryKey, { workflow_ir: doc('x'), workflow_id: randomUUID() });
    expect(res.ok).toBe(false);
    expect(res.data.code).toBe('ambiguous_document');
  });

  it('is not offered at all to a key with neither run scope', async () => {
    const readOnly = 'ork_tw_read_key_cccccccccccccccccc';
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at)
       VALUES (gen_random_uuid(),$1,$2,'read',$3,'ork_tw_read_',$4,now())`,
      [userId, orgId, hash(readOnly), JSON.stringify(['workflow:read'])],
    );
    const client = await connect(readOnly);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('orchestr_test_workflow');
    await client.close();
  });
});
