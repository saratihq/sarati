import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { SDK_ACTIONS_FETCH } from '../src/providers/sdk-actions.provider';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Gmail behind our own Gmail actions: the mailbox each token opens, and how often it was asked. */
let mailbox = 'first@e2e.local';
let profileCalls = 0;
const gmailFetch: FetchLike = (input) => {
  const url = new URL(String(input));
  const body = url.pathname.endsWith('/profile')
    ? (profileCalls++, { emailAddress: mailbox, messagesTotal: 1, threadsTotal: 1, historyId: '1' })
    : { messages: [], resultSizeEstimate: 0 };
  const res: FetchLikeResponse = {
    status: 200,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
  return Promise.resolve(res);
};

/** Which account a connection is, as every surface that names a connection reports it. */
describe('a connection knows which account it is (e2e, isolated DB, stubbed Gmail, mock auth)', () => {
  let app: INestApplication;
  let userId = '';
  let connectionId = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_ACTIONS_FETCH)
      .useValue(gmailFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    userId = (await http().get('/api/auth/me').expect(200)).body.user.id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('asks the moment a connection becomes usable, and lists it with the account', async () => {
    const created = await app
      .get(ConnectionsService)
      .createOAuth2(userId, 'gmail', { access_token: 'tok', token_type: 'Bearer', raw: {} });
    connectionId = created.id;
    expect(profileCalls).toBe(1);

    const list = await http().get('/api/connections').expect(200);
    expect(list.body.find((c: { id: string }) => c.id === connectionId)).toMatchObject({
      provider: 'gmail',
      account: { subject: 'user', email: 'first@e2e.local', id: 'first@e2e.local', name: null, handle: null },
    });
  });

  it('answers from what the provider said, and asks again only when told to', async () => {
    const stored = await http().get(`/api/connections/${connectionId}/account`).expect(200);
    expect(stored.body).toEqual({
      account: expect.objectContaining({ email: 'first@e2e.local' }),
      detail: 'Authorized against first@e2e.local.',
    });
    expect(profileCalls).toBe(1);

    mailbox = 'second@e2e.local';
    const refreshed = await http().get(`/api/connections/${connectionId}/account?refresh=1`).expect(200);
    expect(refreshed.body.account).toMatchObject({ email: 'second@e2e.local' });
    expect(profileCalls).toBe(2);
    const list = await http().get('/api/connections').expect(200);
    expect(list.body.find((c: { id: string }) => c.id === connectionId).account.email).toBe(
      'second@e2e.local',
    );
  });

  it('names an environment slot by its account rather than the app', async () => {
    const envs = await http().get('/api/environments').expect(200);
    const staging = (envs.body.environments as Array<{ id: string; name: string }>).find(
      (e) => e.name === 'staging',
    )!;
    await http()
      .put(`/api/environments/${staging.id}/slots/gmail`)
      .send({ connection_id: connectionId })
      .expect(200);
    const after = await http().get('/api/environments').expect(200);
    const slot = (after.body.environments as Array<{ name: string; slots: Array<Record<string, unknown>> }>)
      .find((e) => e.name === 'staging')!
      .slots.find((s) => s.app === 'gmail');
    expect(slot).toMatchObject({ connection_id: connectionId, account_label: 'second@e2e.local' });
    await http().delete(`/api/environments/${staging.id}/slots/gmail`).expect(200);
  });

  it('warns on save when {{$account…}} cannot be filled', async () => {
    const step = (id: string, parameters: Record<string, unknown>) => ({
      id,
      name: id,
      node_type: 'gmail.list_messages',
      type_version: 1,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const res = await http()
      .post('/api/deploy')
      .send({
        workflow_json: {
          version: '1',
          name: 'account refs',
          description: '',
          nodes: [
            step('mine', { connectionId, query: 'to:{{$account.email}}' }),
            step('typo', { connectionId, query: 'to:{{$account.mail}}' }),
            step('nobody', { query: 'to:{{$account.email}}' }),
          ],
          edges: [],
          settings: { execution_order: 'v1', extra: {} },
          metadata: { engine: 'orchestr' },
        },
      })
      .expect(201);
    expect(res.body.ref_warnings).toEqual([
      '"typo" uses {{$account.mail}}, but an account has only an email, handle, id and name',
      '"nobody" uses {{$account.email}}, but runs as no connected account, so nothing can fill it',
    ]);
  });
});
