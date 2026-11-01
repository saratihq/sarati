import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { mintSession } from '../src/auth/local/local-session';
import { configureApp } from '../src/bootstrap';
import { LIVE_RUNS_PER_HOUR } from '../src/mcp/live-run-consent.service';
import { listenOnLoopback } from './support/listen';
import { insertPersonalOrgs } from './support/personal-org';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface ToolCall {
  ok: boolean;
  data: Record<string, unknown>;
  text: string;
}

/** Tool 15: dry by default, and firing for real needs scope AND consent for THIS document. */
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
  const secretKey = 'an-e2e-secret-key-for-mcp-test-workflow-sessions';
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

  async function connect(key: string, headers: Record<string, string> = {}): Promise<Client> {
    const client = new Client({ name: 'tw-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { ...headers, Authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  async function callOn(client: Client, args: Record<string, unknown>): Promise<ToolCall> {
    const result = await client.callTool({ name: 'orchestr_test_workflow', arguments: args });
    return {
      ok: !result.isError,
      data: (result.structuredContent ?? {}) as Record<string, unknown>,
      text: ((result.content as { text?: string }[])[0]?.text ?? '').slice(0, 300),
    };
  }

  async function call(key: string, args: Record<string, unknown>): Promise<ToolCall> {
    const client = await connect(key);
    try {
      return await callOn(client, args);
    } finally {
      await client.close();
    }
  }

  async function fireLive(client: Client, text: string): Promise<ToolCall> {
    const dry = await callOn(client, { workflow_ir: doc(text) });
    if (!dry.ok) throw new Error(`dry run refused: ${dry.text}`);
    return callOn(client, {
      workflow_ir: doc(text),
      dry_run: false,
      confirmation_token: dry.data.confirmation_token,
    });
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
    process.env.SECRET_KEY = secretKey;

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

  it.each([
    ['spelling an error lane copy’s step key', 'a#error/h'],
    ['outside the authored id format', 'a.b'],
  ])('refuses a document with a node id %s before any step runs', async (_what, id) => {
    posts = 0;
    const ir = doc('refused');
    (ir.nodes as Array<Record<string, unknown>>)[0]!.id = id;
    const res = await call(dryKey, { workflow_ir: ir });
    expect(res.ok).toBe(false);
    expect(res.text).toContain(`Node id "${id}"`);
    expect(posts).toBe(0);
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
    // The stub server is what makes the run slow — a GET is not stubbed by a dry run.
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

  it('a key that cannot read runs is told so, not pointed at a tool it does not hold', async () => {
    // `/mcp` itself takes `workflow:read` or `workflow:invoke`, so this is the key that can preview without reading.
    const dryOnly = 'ork_tw_dry_only_dddddddddddddddddd';
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at)
       VALUES (gen_random_uuid(),$1,$2,'dry-only',$3,'ork_tw_dry_o',$4,now())`,
      [userId, orgId, hash(dryOnly), JSON.stringify(['workflow:invoke', 'run:dry'])],
    );
    const client = await connect(dryOnly);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('orchestr_get_run');
    await client.close();

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
    const res = await call(dryOnly, { workflow_ir: slow, await_ms: 100 });
    if (!res.ok) throw new Error(`handle run failed: ${res.text}`);
    expect(res.data.status).toBe('running');
    expect(res.data.poll_with).toBeUndefined();
    expect(res.data.note).toContain('workflow:read');
  });

  it('refuses an ambiguous request rather than guessing which document to run', async () => {
    const res = await call(dryKey, { workflow_ir: doc('x'), workflow_id: randomUUID() });
    expect(res.ok).toBe(false);
    expect(res.data.code).toBe('ambiguous_document');
  });

  it("never reads another org's workflow: it answers exactly as for one that does not exist", async () => {
    const otherOrg = randomUUID();
    const foreign = randomUUID();
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1,'Elsewhere',false,now(),now())`,
      [otherOrg],
    );
    await db.query(`INSERT INTO workflows (id, name, org_id) VALUES ($1, 'theirs', $2)`, [foreign, otherOrg]);
    await db.query(
      `INSERT INTO workflow_branches (workflow_id, name, is_default) VALUES ($1, 'main', true)`,
      [foreign],
    );
    const missing = randomUUID();

    for (const branch of ['x', undefined]) {
      const theirs = await call(dryKey, { workflow_id: foreign, ...(branch ? { branch } : {}) });
      const nobody = await call(dryKey, { workflow_id: missing, ...(branch ? { branch } : {}) });
      expect(theirs.ok).toBe(false);
      expect(theirs.text.replace(foreign, '<id>')).toBe(nobody.text.replace(missing, '<id>'));
    }
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

  it('caps live runs per person across all of their keys, sessions and workspaces, and leaves another person theirs', async () => {
    const spender = randomUUID();
    const bystander = randomUUID();
    const spenderPersonal = randomUUID();
    const [first, theirs] = ['ork_tw_spend_one_eeeeeeeeeeeeeeeee', 'ork_tw_bystander_gggggggggggggggg'];
    const scopes = ['workflow:read', 'run:dry', 'run:execute'];
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1,'spender@e2e.local','Spender',now(),now()), ($2,'bystander@e2e.local','Bystander',now(),now())`,
      [spender, bystander],
    );
    await insertPersonalOrgs(db, { id: spenderPersonal, userId: spender, name: 'Spender' });
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(),$1,$2,'member',now()), (gen_random_uuid(),$1,$3,'member',now())`,
      [orgId, spender, bystander],
    );
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at)
       VALUES (gen_random_uuid(),$1,$3,'first',$4,'ork_tw_spend',$6,now()),
              (gen_random_uuid(),$2,$3,'theirs',$5,'ork_tw_bysta',$6,now())`,
      [spender, bystander, orgId, hash(first), hash(theirs), JSON.stringify(scopes)],
    );
    const session = (await mintSession(spender, secretKey)).token;
    const issued = await request(app.getHttpServer())
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${session}`)
      .send({ name: 'second', scopes })
      .expect(201);
    const second = issued.body.key as string;
    const pinned = await db.query<{ org_id: string }>(`SELECT org_id FROM api_keys WHERE id = $1`, [
      issued.body.id,
    ]);
    expect(pinned.rows[0]?.org_id).toBe(spenderPersonal);

    const clients: Record<string, Client> = {};
    try {
      clients.first = await connect(first);
      clients.session = await connect(session, { 'X-Org-Id': orgId });
      clients.second = await connect(second);
      clients.theirs = await connect(theirs);

      posts = 0;
      for (let i = 0; i < LIVE_RUNS_PER_HOUR; i++) {
        const fired = await fireLive(i % 2 === 0 ? clients.first : clients.session, `spend ${i}`);
        if (!fired.ok) throw new Error(`live run ${i} refused: ${fired.text}`);
      }
      expect(posts).toBe(LIVE_RUNS_PER_HOUR);

      const refused = await fireLive(clients.second, 'one too many');
      expect(refused.ok).toBe(false);
      expect(refused.data).toMatchObject({
        code: 'live_run_budget_exhausted',
        error: `You have fired ${LIVE_RUNS_PER_HOUR} live runs through MCP in the last hour, across all of your keys and sessions, which is the limit for one person. Dry runs are unaffected.`,
      });
      expect(posts).toBe(LIVE_RUNS_PER_HOUR);

      const elsewhere = await fireLive(clients.theirs, 'someone else');
      expect(elsewhere.ok).toBe(true);
      expect(posts).toBe(LIVE_RUNS_PER_HOUR + 1);
    } finally {
      await Promise.all(Object.values(clients).map((client) => client.close()));
    }
  }, 60_000);
});
