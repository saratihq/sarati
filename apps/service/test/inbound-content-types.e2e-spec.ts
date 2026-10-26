import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const SECRET = 'content-types-signing-secret';
const LATIN1_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xe9]);

const node = (id: string, nodeType: string, parameters: Record<string, unknown>, x: number) => ({
  id,
  name: id,
  node_type: nodeType,
  type_version: 1,
  parameters,
  position: { x, y: 0 },
  metadata: {},
});

const edge = (from: string, to: string) => ({
  id: `e-${from}-${to}`,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type: 'main',
});

// `fields` reads a field both ways; `shape` serializes the whole `{{trigger.body}}` with its type kept.
const webhookDoc = (name: string, verification?: Record<string, unknown>): Record<string, unknown> => ({
  version: '1.0',
  name,
  description: '',
  nodes: [
    node('trigger', 'orchestr:webhook', verification ? { verification } : {}, 0),
    node('fields', 'text.concat', { texts: ['{{trigger.body.marker}}', '/', '{{trigger.marker}}'] }, 300),
    node('shape', 'text.concat', { texts: [{ body: '{{trigger.body}}' }] }, 600),
  ],
  edges: [edge('trigger', 'fields'), edge('fields', 'shape')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

const chatDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'chat content types',
  description: '',
  nodes: [
    node('chat', 'orchestr:chat', {}, 0),
    node('reply', 'text.concat', { texts: ['[', '{{trigger.chatInput}}', ']'] }, 300),
  ],
  edges: [edge('chat', 'reply')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

interface Run {
  status: string;
  outputs: Record<string, unknown>;
}

describe('inbound bodies of every content type reach the run, signed over their exact bytes (e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const userA = randomUUID();
  const keyA = 'ork_e2e_contenttypes_aaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  let orgId = '';
  let openWf = '';
  let githubWf = '';
  let stripeWf = '';
  let chatWf = '';

  const post = (path: string, contentType: string, bytes: Buffer | string): request.Test =>
    http().post(path).set('Content-Type', contentType).send(bytes);
  const githubSig = (bytes: Buffer | string): string =>
    'sha256=' + createHmac('sha256', SECRET).update(bytes).digest('hex');
  const stripeSig = (bytes: Buffer, t = String(Math.floor(Date.now() / 1000))): string =>
    `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.`).update(bytes).digest('hex')}`;

  async function deploy(doc: Record<string, unknown>): Promise<string> {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: doc }),
    ).expect(201);
    return deployed.body.workflow_id as string;
  }

  async function setSecret(wfId: string): Promise<void> {
    await asA(http().put(`/api/workflows/${wfId}/webhook-secret`).set('X-Org-Id', orgId))
      .send({ node_id: 'trigger', secret: SECRET, environment: 'production' })
      .expect(200);
  }

  async function finished(res: request.Response): Promise<Run> {
    const runId = res.body.run_id as string;
    for (;;) {
      const run = (await asA(http().get(`/api/runs/${runId}`)).expect(200)).body as Run;
      if (run.status === 'completed' || run.status === 'error') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const bodyOf = (run: Run): unknown => (JSON.parse(run.outputs.shape as string) as { body?: unknown }).body;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'types@e2e.local', 'Types', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userA, hash(keyA), keyA.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.DBOS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    orgId = (await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201)).body.id as string;
    openWf = await deploy(webhookDoc('open webhook'));
    githubWf = await deploy(webhookDoc('github-signed webhook', { preset: 'github' }));
    stripeWf = await deploy(webhookDoc('stripe-signed webhook', { preset: 'stripe' }));
    chatWf = await deploy(chatDoc());
    await setSecret(githubWf);
    await setSecret(stripeWf);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  describe('an unsigned webhook', () => {
    const hook = (): string => `/api/hooks/${openWf}/production`;

    it('form fields land as an object, a repeated field as an array of its values', async () => {
      const run = await finished(
        await post(hook(), 'application/x-www-form-urlencoded', 'marker=HELLO+there&tag=a&tag=b%26c').expect(
          202,
        ),
      );
      expect(run.outputs.fields).toBe('HELLO there/HELLO there');
      expect(bodyOf(run)).toEqual({ marker: 'HELLO there', tag: ['a', 'b&c'] });
    });

    it('form fields are read in the declared charset, percent-escaped bytes included', async () => {
      const run = await finished(
        await post(hook(), 'application/x-www-form-urlencoded; charset=windows-1252', 'marker=Jos%E9').expect(
          202,
        ),
      );
      expect(run.outputs.fields).toBe('José/José');
    });

    it('a text body is the string itself', async () => {
      const run = await finished(await post(hook(), 'text/plain', 'hello world').expect(202));
      expect(bodyOf(run)).toBe('hello world');
    });

    it('a body with no Content-Type is read as UTF-8 text', async () => {
      const run = await finished(await http().post(hook()).send(Buffer.from('ping')).expect(202));
      expect(bodyOf(run)).toBe('ping');
    });

    it('a +json media type is parsed as JSON', async () => {
      const event = JSON.stringify({ specversion: '1.0', marker: 'CE' });
      const run = await finished(await post(hook(), 'application/cloudevents+json', event).expect(202));
      expect(run.outputs.fields).toBe('CE/CE');
    });

    it.each([
      ['42', 42],
      ['"ping"', 'ping'],
      ['true', true],
      ['null', null],
    ])('a top-level JSON scalar %s is the body', async (raw, expected) => {
      const run = await finished(await post(hook(), 'application/json', raw).expect(202));
      expect(bodyOf(run)).toEqual(expected);
    });

    it('invalid JSON is refused 400 and says so', async () => {
      const res = await post(hook(), 'application/json', '{"marker":').expect(400);
      expect(res.body.detail).toBe('The request body is not valid JSON');
    });

    it.each([
      ['application/octet-stream', Buffer.from([0, 1, 2])],
      [
        'multipart/form-data; boundary=x',
        '--x\r\nContent-Disposition: form-data; name="marker"\r\n\r\nM\r\n--x--',
      ],
    ])('a %s body is refused 415, never accepted with its payload dropped', async (type, bytes) => {
      const res = await post(hook(), type, bytes).expect(415);
      expect(res.body.detail).toBe(
        `Unsupported Content-Type "${type.split(';')[0]}": send JSON, form fields or text`,
      );
    });

    it('a Content-Encoding the reader cannot undo is refused 415 and says which', async () => {
      const res = await post(hook(), 'text/plain', 'hi').set('Content-Encoding', 'zstd').expect(415);
      expect(res.body).toEqual({ detail: 'unsupported content encoding "zstd"' });
    });

    it('an empty POST with no Content-Type still starts a run, with no body', async () => {
      const run = await finished(await http().post(hook()).expect(202));
      expect(run.status).toBe('completed');
      expect(bodyOf(run)).toBeUndefined();
    });
  });

  describe('a signed webhook verifies the exact bytes received', () => {
    const hook = (): string => `/api/hooks/${githubWf}/production`;
    const form = 'payload=%7B%22marker%22%3A%22GH%22%7D';

    it('a GitHub form delivery signed over its bytes is accepted, and the run gets its event', async () => {
      const res = await post(hook(), 'application/x-www-form-urlencoded', form)
        .set('x-github-event', 'issues')
        .set('x-hub-signature-256', githubSig(form))
        .expect(202);
      const run = await finished(res);
      expect(run.outputs.fields).toBe('GH/GH');
      expect(bodyOf(run)).toEqual({ marker: 'GH' });
    });

    it('the same bytes with a wrong signature, or none, are refused 401', async () => {
      await post(hook(), 'application/x-www-form-urlencoded', form)
        .set('x-hub-signature-256', githubSig(`${form}&x=1`))
        .expect(401);
      await post(hook(), 'application/x-www-form-urlencoded', form).expect(401);
    });

    it('a Latin-1 text body is signed over its raw bytes and decoded by its charset', async () => {
      const res = await post(hook(), 'text/plain; charset=iso-8859-1', LATIN1_CAFE)
        .set('x-hub-signature-256', githubSig(LATIN1_CAFE))
        .expect(202);
      expect(bodyOf(await finished(res))).toBe('café');
    });

    it('an empty body signed over no bytes is accepted, and unsigned it is refused', async () => {
      await post(hook(), 'application/json', '').set('x-hub-signature-256', githubSig('')).expect(202);
      await post(hook(), 'application/json', '').expect(401);
    });

    it('Stripe signs the timestamp then the exact bytes', async () => {
      const res = await post(
        `/api/hooks/${stripeWf}/production`,
        'text/plain; charset=iso-8859-1',
        LATIN1_CAFE,
      )
        .set('stripe-signature', stripeSig(LATIN1_CAFE))
        .expect(202);
      expect(bodyOf(await finished(res))).toBe('café');
    });
  });

  describe('the test-event catch', () => {
    it.each([
      ['application/x-www-form-urlencoded', 'marker=HELLO', { marker: 'HELLO', body: { marker: 'HELLO' } }],
      ['text/plain', 'just text', { body: 'just text' }],
    ])('keeps a %s sample as the trigger a run would see', async (type, bytes, expected) => {
      const minted = await asA(http().post('/api/catch')).expect(201);
      await post(minted.body.path as string, type, bytes).expect(201);
      const got = await asA(http().get(`/api/catch/${minted.body.catch_id as string}`)).expect(200);
      expect(got.body).toEqual({ received: true, payload: expected });
    });
  });

  describe('the chat intake', () => {
    const chat = (): string => `/api/chat/${chatWf}/production`;

    it('takes chatInput and sessionId as form fields', async () => {
      const res = await post(
        chat(),
        'application/x-www-form-urlencoded',
        'chatInput=hi+there&sessionId=s-1',
      ).expect(200);
      expect(res.body.reply).toBe('[hi there]');
      expect(res.body.session_id).toBe('s-1');
    });

    it.each([
      ['text/plain', 'hello'],
      ['application/json', '"hello"'],
    ])('takes a %s string body as the message', async (type, bytes) => {
      const res = await post(chat(), type, bytes).expect(200);
      expect(res.body.reply).toBe('[hello]');
    });

    it('refuses a body that is neither the message nor an object carrying one', async () => {
      await post(chat(), 'application/json', '42').expect(400);
    });
  });
});
