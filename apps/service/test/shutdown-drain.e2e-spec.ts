import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const LOST_DATABASE = /Driver not Connected|Connection terminated/;

function webhookDoc(name: string, step: { node_type: string; parameters: Record<string, unknown> }) {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a request arrives',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      { id: 'step', name: 'Step', type_version: 1, position: { x: 300, y: 0 }, metadata: {}, ...step },
    ],
    edges: [
      {
        id: 'e-trigger-step',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'step',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

async function eventually<T>(
  what: string,
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never saw ${what}`);
}

/** Shutdown owns the in-process runs a webhook started (DBOS off): it waits for one in flight, never for one parked. */
describe('shutdown waits for in-process runs (e2e, isolated DB, DBOS off)', () => {
  let fixture: Server;
  let base = '';
  const held: ServerResponse[] = [];

  beforeAll(async () => {
    fixture = createServer((req, res) => {
      if (req.url === '/gate') {
        held.push(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const res of held.splice(0)) res.end();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
  });

  it('closing the service waits for a run whose step is in flight, which then completes with its database still there', async () => {
    const databaseUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'false';
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      const write = Logger.prototype[level];
      jest.spyOn(Logger.prototype, level).mockImplementation(function (
        this: Logger,
        message: unknown,
        ...rest
      ) {
        lines.push(String(message));
        return write.call(this, message, ...rest);
      });
    }
    let app: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
      configureApp(app);
      await app.init();
      await listenOnLoopback(app);
      const http = request(app.getHttpServer());
      const doc = webhookDoc('held step', {
        node_type: 'http.send_request',
        parameters: { method: 'GET', url: `${base}/gate` },
      });
      const wf = (await http.post('/api/deploy').send({ workflow_json: doc }).expect(201)).body
        .workflow_id as string;
      const fired = await request(app.getHttpServer())
        .post(`/api/hooks/${wf}/production`)
        .send({ hello: 'drain' })
        .expect(202);
      await eventually(
        'the step reach its fixture',
        () => held.length,
        (n) => n === 1,
      );

      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      app = undefined;
      await eventually(
        'shutdown say it waits for the run',
        () => lines,
        (seen) =>
          seen.some((line) => line.startsWith('Shutting down: waiting up to 8000 ms for 1 in-process run')),
      );
      expect(closed).toBe(false);

      for (const res of held.splice(0)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
      await closing;

      const run = await db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE id = $1`, [
        `${MOCK_USER_ID}:${fired.body.run_id as string}`,
      ]);
      expect(run.rows).toEqual([{ status: 'completed' }]);
      expect(lines.filter((line) => LOST_DATABASE.test(line) || line.includes('stopped waiting'))).toEqual(
        [],
      );
    } finally {
      jest.restoreAllMocks();
      await app?.close();
      await db.end();
      process.env.DATABASE_URL = ADMIN_URL;
      process.env.MOCK_AUTH = 'false';
    }
  }, 60_000);

  describe('a service stopped with SIGTERM', () => {
    let databaseUrl = '';
    let db: Client;
    let service: ServiceProcess | undefined;

    beforeAll(async () => {
      databaseUrl = await createE2eDatabase(ADMIN_URL);
      db = new Client({ connectionString: databaseUrl });
      await db.connect();
      service = await bootService({ service: THIS_SERVICE, databaseUrl, env: { DBOS_ENABLED: 'false' } });
    }, 90_000);

    afterAll(async () => {
      await service?.crash();
      await db.end();
    }, 30_000);

    it('exits at once while a run is parked on a wait for an event, waiting for nothing', async () => {
      const post = (path: string, body: unknown) =>
        fetch(`${service!.base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const doc = webhookDoc('parked step', {
        node_type: 'orchestr:wait_for_event',
        parameters: { topic: 'approval', timeout_ms: 600_000 },
      });
      const deployed = await post('/api/deploy', { workflow_json: doc });
      expect(deployed.status).toBe(201);
      const wf = ((await deployed.json()) as { workflow_id: string }).workflow_id;
      const fired = await post(`/api/hooks/${wf}/production`, { hello: 'parked' });
      expect(fired.status).toBe(202);
      const runId = ((await fired.json()) as { run_id: string }).run_id;
      await eventually(
        'the run park',
        async () =>
          (
            await db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE id = $1`, [
              `${MOCK_USER_ID}:${runId}`,
            ])
          ).rows[0]?.status,
        (status) => status === 'waiting',
      );

      await service!.terminate();
      expect(service!.log()).not.toMatch(/Shutting down: (waiting up to|stopped waiting)/);
    }, 60_000);

    it('stops waiting for a run still in flight once 8 s are up, names it, and exits', async () => {
      const again = await bootService({ service: THIS_SERVICE, databaseUrl, env: { DBOS_ENABLED: 'false' } });
      try {
        const post = (path: string, body: unknown) =>
          fetch(`${again.base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        const doc = webhookDoc('never ends', {
          node_type: 'http.send_request',
          parameters: { method: 'GET', url: `${base}/gate` },
        });
        const deployed = await post('/api/deploy', { workflow_json: doc });
        expect(deployed.status).toBe(201);
        const wf = ((await deployed.json()) as { workflow_id: string }).workflow_id;
        const fired = await post(`/api/hooks/${wf}/production`, { hello: 'stuck' });
        expect(fired.status).toBe(202);
        const runId = ((await fired.json()) as { run_id: string }).run_id;
        await eventually(
          'the step reach its fixture',
          () => held.length,
          (n) => n === 1,
        );
        await again.terminate();
        expect(again.log()).toContain(
          `stopped waiting for in-process run(s) still going after 8000 ms: ${MOCK_USER_ID}:${runId}`,
        );
      } finally {
        await again.crash();
        for (const res of held.splice(0)) res.end();
      }
    }, 30_000);
  });
});
