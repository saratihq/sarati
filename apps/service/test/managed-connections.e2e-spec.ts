import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService, MANAGED_TOKEN_PREFIX } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const AUTH_CONFIG_ID = 'ac_stub_slack';
const ACCOUNT_ID = 'ca_stub_account_1';
const REDIRECT_URL = 'https://connect.composio.test/link/abc';

/** Managed (Composio-brokered) connections end to end against a stubbed Composio (COMPOSIO_BASE_URL). */
describe('managed connections (e2e, isolated DB, stubbed Composio, mock auth)', () => {
  let app: INestApplication;
  let composioStub: Server;
  let connectionId = '';
  /** Wire log: what our service asked Composio for. */
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  /** Flipped by the test to simulate the user completing the hosted flow. */
  let accountStatus = 'INITIALIZING';
  let authConfigCreates = 0;
  let accountDeletes = 0;
  /** What the stub answers to account DELETEs (the cleanup is best-effort). */
  let deleteReplyStatus = 200;
  /** What the stub answers to account GETs (the health tests simulate a Composio outage). */
  let accountReplyStatus = 200;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    composioStub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body: unknown = raw ? JSON.parse(raw) : null;
        const url = req.url ?? '';
        calls.push({ method: req.method ?? '', url, body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (req.method === 'GET' && url.startsWith('/api/v3/toolkits')) {
          // A BYO-only toolkit (empty managed schemes) can't be brokered and must be filtered out.
          json(200, {
            items: [
              { slug: 'slack', name: 'Slack', composio_managed_auth_schemes: ['OAUTH2'] },
              { slug: 'notinmanifest', name: 'Not In Manifest', composio_managed_auth_schemes: ['OAUTH2'] },
              { slug: 'github', name: 'GitHub', composio_managed_auth_schemes: [] },
            ],
            next_cursor: null,
          });
          return;
        }
        if (req.method === 'GET' && url.startsWith('/api/v3/auth_configs')) {
          json(200, { items: [] }); // nothing to adopt → create path
          return;
        }
        if (req.method === 'POST' && url === '/api/v3/auth_configs') {
          authConfigCreates += 1;
          json(201, { toolkit: { slug: 'slack' }, auth_config: { id: AUTH_CONFIG_ID } });
          return;
        }
        if (req.method === 'POST' && url === '/api/v3/connected_accounts/link') {
          json(201, { redirect_url: REDIRECT_URL, connected_account_id: ACCOUNT_ID });
          return;
        }
        if (req.method === 'GET' && url === `/api/v3/connected_accounts/${ACCOUNT_ID}`) {
          if (accountReplyStatus !== 200) {
            json(accountReplyStatus, { error: 'temporarily unavailable' });
            return;
          }
          // `state.val` carries non-secret metadata (→ auth.data) plus the MASKED token (dropped).
          json(200, {
            id: ACCOUNT_ID,
            status: accountStatus,
            state: {
              val: {
                token_type: 'Bearer',
                scope: 'chat:write',
                instance_url: 'https://na1.salesforce.test',
                access_token: 'REDACTED_masked_by_composio',
              },
            },
          });
          return;
        }
        if (req.method === 'DELETE' && url === `/api/v3/connected_accounts/${ACCOUNT_ID}`) {
          accountDeletes += 1;
          json(deleteReplyStatus, deleteReplyStatus === 200 ? { success: true } : { error: 'not found' });
          return;
        }
        json(404, { error: `unexpected ${req.method} ${url}` });
      });
    });
    await new Promise<void>((resolve) => composioStub.listen(0, '127.0.0.1', resolve));
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composioStub.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    // The managed rail's key lives in the store, not the environment.
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => composioStub.close(resolve));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    delete process.env.COMPOSIO_BASE_URL;
  });

  it('offers every managed-auth toolkit under our slug (the full Composio catalog); BYO-only toolkits excluded', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections/managed/apps').expect(200);
    // Both managed toolkits are offered; github (BYO-only) is excluded. Sorted by display name.
    expect(res.body).toEqual({
      apps: [
        { slug: 'notinmanifest', name: 'Not In Manifest', executable: true },
        { slug: 'slack', name: 'Slack', executable: true },
      ],
    });
  });

  it('filters apps with ?q= (and serves the toolkit list from the in-process cache)', async () => {
    const toolkitCallsBefore = calls.filter((c) => c.url.startsWith('/api/v3/toolkits')).length;
    const hit = await request(app.getHttpServer()).get('/api/connections/managed/apps?q=SLA').expect(200);
    expect(hit.body.apps).toEqual([{ slug: 'slack', name: 'Slack', executable: true }]);
    const miss = await request(app.getHttpServer()).get('/api/connections/managed/apps?q=zzz').expect(200);
    expect(miss.body.apps).toEqual([]);
    const toolkitCallsAfter = calls.filter((c) => c.url.startsWith('/api/v3/toolkits')).length;
    expect(toolkitCallsAfter).toBe(toolkitCallsBefore); // cached — no re-fetch
  });

  it('starts a connect: 201 with the hosted link and a pending connection row', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/connections/managed/link')
      .send({ app: 'slack' })
      .expect(201);
    expect(res.body.redirect_url).toBe(REDIRECT_URL);
    expect(typeof res.body.connection_id).toBe('string');
    connectionId = res.body.connection_id;

    // The auth config was created once and the link was minted for the CALLER.
    expect(authConfigCreates).toBe(1);
    const linkCall = calls.find((c) => c.url === '/api/v3/connected_accounts/link');
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    expect(linkCall?.body).toEqual({ auth_config_id: AUTH_CONFIG_ID, user_id: me.body.user.id });
  });

  it('rejects an app the managed catalog cannot broker with a 400', async () => {
    // github is returned by Composio with NO managed auth schemes, so a managed link must be refused.
    const res = await request(app.getHttpServer())
      .post('/api/connections/managed/link')
      .send({ app: 'github' })
      .expect(400);
    expect(res.body.detail).toContain('github');
  });

  it('reports pending while the hosted flow is incomplete', async () => {
    const res = await request(app.getHttpServer()).get(`/api/connections/${connectionId}/status`).expect(200);
    expect(res.body).toEqual({ status: 'pending' });
  });

  it('marks the row pending in the connections list (client must not auto-attach it)', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections').expect(200);
    const row = res.body.find((c: { id: string }) => c.id === connectionId);
    expect(row).toMatchObject({ auth_type: 'managed', status: 'pending' });
  });

  it('resolving the credential of a pending connection fails actionably', async () => {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    await expect(app.get(ConnectionsService).getCredential(me.body.user.id, connectionId)).rejects.toThrow(
      /not active yet/,
    );
  });

  it('flips the row active when Composio reports ACTIVE (then stops polling)', async () => {
    accountStatus = 'ACTIVE';
    const res = await request(app.getHttpServer()).get(`/api/connections/${connectionId}/status`).expect(200);
    expect(res.body).toEqual({ status: 'active' });

    // Once persisted active, the endpoint answers from the row — no more polls.
    const pollsBefore = calls.filter((c) => c.url === `/api/v3/connected_accounts/${ACCOUNT_ID}`).length;
    await request(app.getHttpServer()).get(`/api/connections/${connectionId}/status`).expect(200);
    const pollsAfter = calls.filter((c) => c.url === `/api/v3/connected_accounts/${ACCOUNT_ID}`).length;
    expect(pollsAfter).toBe(pollsBefore);
  });

  it('lists the managed row alongside the others, secret-free and now active', async () => {
    const res = await request(app.getHttpServer()).get('/api/connections').expect(200);
    const row = res.body.find((c: { id: string }) => c.id === connectionId);
    expect(row).toMatchObject({ provider: 'slack', auth_type: 'managed', status: 'active' });
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT_ID); // reference stays internal
  });

  it('resolves the credential to the transport sentinel, shaped for every auth pattern', async () => {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const cred = await app.get(ConnectionsService).getCredential(me.body.user.id, connectionId);
    const sentinel = `${MANAGED_TOKEN_PREFIX}${ACCOUNT_ID}`;
    // The sentinel is shaped for every auth pattern: access_token, secret_text, and auth.data.
    expect(cred).toEqual({
      access_token: sentinel,
      secret_text: sentinel,
      data: { token_type: 'Bearer', scope: 'chat:write', instance_url: 'https://na1.salesforce.test' },
    });
    // The masked token stays masked — only the routable sentinel is ever surfaced.
    expect(JSON.stringify(cred)).not.toContain('REDACTED');
  });

  it('404s the status of a connection that does not exist', async () => {
    await request(app.getHttpServer())
      .get('/api/connections/00000000-0000-0000-0000-000000000000/status')
      .expect(404);
  });

  // ─── Connection health (H4): the test probe against the live account status ───

  const listedRow = async (id: string): Promise<Record<string, unknown>> => {
    const list = await request(app.getHttpServer()).get('/api/connections').expect(200);
    return list.body.find((c: { id: string }) => c.id === id);
  };

  it('test-probes an ACTIVE managed row against Composio and stamps last_checked_at', async () => {
    const res = await request(app.getHttpServer()).post(`/api/connections/${connectionId}/test`).expect(200);
    expect(res.body).toMatchObject({ ok: true, status: 'active' });
    const row = await listedRow(connectionId);
    expect(row).toMatchObject({ status: 'active', status_reason: null });
    expect(typeof row.last_checked_at).toBe('string');
  });

  it('flips a managed row to expired (plain-language reason) when Composio reports EXPIRED', async () => {
    accountStatus = 'EXPIRED';
    const res = await request(app.getHttpServer()).post(`/api/connections/${connectionId}/test`).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('expired');
    expect(res.body.detail).toContain('reconnect');
    const row = await listedRow(connectionId);
    expect(row.status).toBe('expired');
    expect(row.status_reason).toContain('reconnect');
  });

  it('keeps the stored status when Composio is unreachable — an indeterminate probe changes nothing', async () => {
    accountReplyStatus = 502;
    const res = await request(app.getHttpServer()).post(`/api/connections/${connectionId}/test`).expect(200);
    accountReplyStatus = 200;
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('expired'); // unchanged from the previous test
    expect(res.body.detail).toContain('try again shortly');
    expect(await listedRow(connectionId)).toMatchObject({ status: 'expired' });
  });

  it('recovers the row to active when Composio reports ACTIVE again', async () => {
    accountStatus = 'ACTIVE';
    const res = await request(app.getHttpServer()).post(`/api/connections/${connectionId}/test`).expect(200);
    expect(res.body).toMatchObject({ ok: true, status: 'active' });
    expect(await listedRow(connectionId)).toMatchObject({ status: 'active', status_reason: null });
  });

  it('DELETE removes the row and the Composio connected account', async () => {
    await request(app.getHttpServer()).delete(`/api/connections/${connectionId}`).expect(200);
    expect(accountDeletes).toBe(1);
    await request(app.getHttpServer()).delete(`/api/connections/${connectionId}`).expect(404);
  });

  it('DELETE of a still-pending row succeeds even when Composio rejects the cleanup', async () => {
    // A never-activated account may 404 on Composio's side — the cleanup is best-effort.
    const link = await request(app.getHttpServer())
      .post('/api/connections/managed/link')
      .send({ app: 'slack' })
      .expect(201);
    deleteReplyStatus = 404;
    await request(app.getHttpServer()).delete(`/api/connections/${link.body.connection_id}`).expect(200);
    deleteReplyStatus = 200;
    const list = await request(app.getHttpServer()).get('/api/connections').expect(200);
    expect(list.body.some((c: { id: string }) => c.id === link.body.connection_id)).toBe(false);
  });
});
