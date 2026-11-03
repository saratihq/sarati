import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from 'pg';

import { utcMonthOf } from '../src/platform/composio-usage.service';
import { composioToolFor } from '../src/providers/sdk-actions.registry';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const TRELLO = composioToolFor('trello.add_boards')!.slug;

/** The monthly count across a crash on real DBOS: a recorded step is never charged again, an unrecorded one is charged per attempt. */
describe('the instance’s monthly count across a crash (e2e, real DBOS, child process, loopback Composio)', () => {
  let databaseUrl = '';
  let db: Client;
  let service: ServiceProcess | undefined;
  let composio: Server;
  let origin = '';
  let connectionId = '';
  const executions: string[] = [];
  let holding = false;
  const held: ServerResponse[] = [];

  const answer = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'POST' && path === `/api/v3/tools/execute/${TRELLO}`) {
      executions.push(String(req.headers['x-api-key']));
      if (holding) held.push(res);
      else json(200, { successful: true, data: { board: body.arguments }, error: null });
    } else if (path === '/api/v3/toolkits') {
      json(200, { items: [{ slug: 'trello', name: 'Trello', composio_managed_auth_schemes: ['OAUTH2'] }] });
    } else if (path === '/api/v3/auth_configs') {
      json(
        req.method === 'POST' ? 201 : 200,
        req.method === 'POST' ? { auth_config: { id: 'ac_trello' } } : { items: [] },
      );
    } else if (path === '/api/v3/connected_accounts/link') {
      json(201, { redirect_url: 'https://connect.composio.test/1', connected_account_id: 'ca_durable' });
    } else if (path.startsWith('/api/v3/connected_accounts/')) {
      json(200, { id: 'ca_durable', status: 'ACTIVE', state: { val: {} } });
    } else {
      json(404, { error: `unexpected ${req.method ?? ''} ${path}` });
    }
  };

  const boot = async (): Promise<void> => {
    service = await bootService({
      service: THIS_SERVICE,
      databaseUrl,
      env: {
        INSTANCE_COMPOSIO_API_KEY: 'ik_durable',
        INSTANCE_COMPOSIO_WEBHOOK_SECRET: 'whsec_durable',
        COMPOSIO_BASE_URL: origin,
      },
    });
  };
  const call = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${service!.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const eventually = async <T>(what: string, read: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    for (let i = 0; i < 300; i++) {
      const value = await read().catch(() => undefined);
      if (value !== undefined && done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}\n${service?.log().slice(-4_000) ?? ''}`);
  };
  const actions = async (): Promise<number> =>
    (
      await db.query<{ actions: number }>(
        `SELECT actions FROM composio_usage WHERE user_id = $1 AND month = ${utcMonthOf('now()')}`,
        [MOCK_USER_ID],
      )
    ).rows[0]?.actions ?? 0;
  const statusOf = async (runId: string): Promise<string | undefined> =>
    (
      await db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE id = $1`, [
        `${MOCK_USER_ID}:${runId}`,
      ])
    ).rows[0]?.status;
  const parked = async (runId: string): Promise<number> =>
    (
      await db.query(`SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND waiting_topic IS NOT NULL`, [
        `${MOCK_USER_ID}:${runId}`,
      ])
    ).rowCount ?? 0;
  const board = (name: string) => ({
    kind: 'action',
    id: 'board',
    actionId: 'trello.add_boards',
    props: { name },
    auth: { connectionId },
  });

  beforeAll(async () => {
    composio = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        answer(req, res, text ? (JSON.parse(text) as Record<string, unknown>) : {});
      });
    });
    await new Promise<void>((r) => composio.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(composio.address() as AddressInfo).port}`;
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await boot();
    const link = await call('/api/connections/managed/link', { app: 'trello' });
    expect(link.status).toBe(201);
    connectionId = ((await link.json()) as { connection_id: string }).connection_id;
    const status = await call(`/api/connections/${connectionId}/status`);
    expect(await status.json()).toEqual({ status: 'active' });
  }, 90_000);

  afterAll(async () => {
    await service?.crash();
    for (const res of held) res.destroy();
    composio.closeAllConnections();
    await new Promise((r) => composio.close(r));
    await db?.end();
  }, 30_000);

  it('a step DBOS recorded is not run or charged again when its run resumes after a crash', async () => {
    const started = await call('/api/runs/async', {
      run_id: 'recorded',
      plan: {
        id: 'plan-recorded',
        nodes: [
          board('Before the crash'),
          { kind: 'waitForEvent', id: 'go', topic: 'go', timeoutMs: 600_000 },
        ],
      },
    });
    expect(started.status).toBe(201);
    await eventually(
      'the run parked after its step',
      () => parked('recorded'),
      (n) => n === 1,
    );
    expect(executions).toEqual(['ik_durable']);
    expect(await actions()).toBe(1);

    await service!.crash();
    await boot();
    await eventually(
      'the run parked again after recovery',
      () => parked('recorded'),
      (n) => n === 1,
    );
    expect((await call('/api/runs/recorded/events', { topic: 'go', payload: {} })).status).toBe(200);
    await eventually(
      'the run completed',
      () => statusOf('recorded'),
      (s) => s === 'completed',
    );

    expect(executions).toEqual(['ik_durable']);
    expect(await actions()).toBe(1);
  }, 120_000);

  it('a crash while an action is in flight sends and charges it again on recovery — at least once, never unsent and charged', async () => {
    holding = true;
    const started = await call('/api/runs/async', {
      run_id: 'in-flight',
      plan: { id: 'plan-in-flight', nodes: [board('During the crash')] },
    });
    expect(started.status).toBe(201);
    await eventually(
      'the action held in flight',
      () => Promise.resolve(held.length),
      (n) => n === 1,
    );
    expect(await actions()).toBe(2);

    await service!.crash();
    held.splice(0).forEach((res) => res.destroy());
    holding = false;
    await boot();
    await eventually(
      'the run completed',
      () => statusOf('in-flight'),
      (s) => s === 'completed',
    );

    expect(executions).toEqual(['ik_durable', 'ik_durable', 'ik_durable']);
    expect(await actions()).toBe(3);
  }, 120_000);
});
