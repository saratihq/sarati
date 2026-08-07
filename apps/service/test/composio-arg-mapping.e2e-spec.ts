import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const CA_GMAIL = 'ca_argmap_gmail';
const CA_ASANA = 'ca_argmap_asana';

/**
 * Composio arg-mapping through the REAL stack against a stubbed Composio, asserting on the
 * EXACT arguments handed to `tools/execute` — that is where the mapping bugs live.
 */
describe('composio arg-mapping (e2e, isolated DB, stubbed Composio, api-key auth)', () => {
  let app: INestApplication;
  let db: Client;
  let composioStub: Server;
  /** Every typed tools/execute call the stub received — the assertion surface. */
  let toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_argmap_aaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  let gmailConnId = '';
  let asanaConnId = '';

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'argmap-a@e2e.local', 'Argmap A', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Argmap A', true, now(), now())`,
      [personalA],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [personalA, userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userA, hash(keyA), keyA.slice(0, 12)],
    );

    composioStub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = req.url ?? '';
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const typed = /^\/api\/v3\/tools\/execute\/([A-Z0-9_]+)$/.exec(url);
        if (req.method === 'POST' && typed) {
          const body = JSON.parse(raw) as { arguments?: Record<string, unknown> };
          toolCalls.push({ tool: typed[1]!, args: body.arguments ?? {} });
          json(200, { successful: true, data: { ok: true, id: 'srv_1' }, error: null });
          return;
        }
        if (req.method === 'GET' && /^\/api\/v3\/connected_accounts\//.test(url)) {
          json(200, { id: url.split('/').pop(), status: 'ACTIVE', state: { val: {} } });
          return;
        }
        json(404, { error: `unexpected ${req.method} ${url}` });
      });
    });
    await new Promise<void>((resolve) => composioStub.listen(0, '127.0.0.1', resolve));

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.COMPOSIO_API_KEY = 'test-composio-key';
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composioStub.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const connections = app.get(ConnectionsService);
    gmailConnId = (await connections.createManaged(userA, 'gmail', CA_GMAIL)).id;
    await connections.setStatus(gmailConnId, 'active');
    asanaConnId = (await connections.createManaged(userA, 'asana', CA_ASANA)).id;
    await connections.setStatus(asanaConnId, 'active');
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => composioStub.close(resolve));
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
  });

  beforeEach(() => {
    toolCalls = [];
  });

  /** Drive "Test this step" for one action node and return the RunResult body. */
  const testStep = (nodeType: string, parameters: Record<string, unknown>): request.Test =>
    asA(
      http()
        .post('/api/runs/test-step')
        .send({ node: { id: 'step', node_type: nodeType, parameters } }),
    );

  it('(i) maps a Composio-NAME gmail payload — recipient_email reaches GMAIL_SEND_EMAIL', async () => {
    const res = await testStep('gmail.send_email', {
      connectionId: gmailConnId,
      recipient_email: 'to@x.com',
      subject: 'hi',
      body: 'the body',
    }).expect(201);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.tool).toBe('GMAIL_SEND_EMAIL');
    expect(toolCalls[0]!.args).toMatchObject({
      recipient_email: 'to@x.com',
      subject: 'hi',
      body: 'the body',
    });
    // The step ran cleanly (its output is on the trace, no warnings).
    expect(res.body.outputs.step).toMatchObject({ ok: true });
  });

  it('(i-b) still maps the SDK-NAME gmail payload — `to` becomes recipient_email', async () => {
    await testStep('gmail.send_email', {
      connectionId: gmailConnId,
      to: 'to@x.com',
      body: 'the body',
    }).expect(201);
    expect(toolCalls[0]!.args.recipient_email).toBe('to@x.com');
    expect(toolCalls[0]!.args.to).toBeUndefined();
  });

  it('(ii) a missing REQUIRED input is a clean 400 BEFORE Composio is called', async () => {
    const res = await testStep('gmail.send_email', {
      connectionId: gmailConnId,
      subject: 'only a subject', // no recipient_email, no body
    }).expect(400);
    expect(String(res.body.detail ?? res.body.message)).toContain('missing required input(s)');
    expect(toolCalls).toHaveLength(0); // never burned a Composio call
  });

  it('(ii-b) the curated one-of table fires for asana (team/workspace/user) as a clean 400', async () => {
    const res = await testStep('asana.get_team_memberships', {
      connectionId: asanaConnId, // no team/workspace/user
    }).expect(400);
    expect(String(res.body.detail ?? res.body.message)).toContain('provide at least one of');
    expect(toolCalls).toHaveLength(0);
  });

  it('(iii) an array param supplied as a JSON string is healed to an array', async () => {
    await testStep('asana.get_team_memberships', {
      connectionId: asanaConnId,
      team: 't1',
      opt_fields: '["name","email"]',
    }).expect(201);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.tool).toBe('ASANA_GET_TEAM_MEMBERSHIPS');
    expect(toolCalls[0]!.args.opt_fields).toEqual(['name', 'email']);
    expect(toolCalls[0]!.args.team).toBe('t1');
  });

  it('(iv) a genuinely-unmapped prop is surfaced on the run trace (warnings), not swallowed', async () => {
    const res = await testStep('gmail.send_email', {
      connectionId: gmailConnId,
      recipient_email: 'to@x.com',
      body: 'the body',
      totally_unknown_field: 'x',
    }).expect(201);
    // The step still ran; the drop is now visible on the trace.
    const entry = (res.body.trace as Array<{ nodeId: string; warnings?: string[] }>).find((t) =>
      t.nodeId.endsWith('step'),
    );
    expect(entry?.warnings?.some((w) => w.includes('totally_unknown_field'))).toBe(true);
  });
});
