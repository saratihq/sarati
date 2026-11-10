import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from 'pg';

import { ACTIVATION_LOCK_SPACE } from '../src/database/advisory-lock-spaces';
import { bootService, pinoLines, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const WARN = 40;
const TERMINATED = 'terminating connection due to administrator command';

const warned = (service: ServiceProcess, prefix: string): string[] =>
  pinoLines<{ level?: number; msg?: string }>(service.log()).flatMap((line) =>
    line.level === WARN && line.msg?.startsWith(prefix) ? [line.msg] : [],
  );

const statusOf = (service: ServiceProcess, path: string): Promise<number | null> =>
  fetch(`${service.base}${path}`).then(
    (res) => res.status,
    () => null,
  );

async function heard(service: ServiceProcess, prefix: string, count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (warned(service, prefix).length >= count) return;
    if ((await statusOf(service, '/api/health')) === null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `heard ${warned(service, prefix).length} of ${count} "${prefix}…", the service answering: ${String(await statusOf(service, '/api/health'))}\n${service.log().slice(-4_000)}`,
  );
}

function pollingDoc(url: string): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'polled while its lock is lost',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a new item is published',
        node_type: 'http.new_item',
        type_version: 1,
        parameters: { url },
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['polled'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-announce',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

describe('the service stays up when the database ends a connection it holds (e2e, own process)', () => {
  const held: ServerResponse[] = [];
  const feed = createServer((_req, res) => held.push(res));
  let db: Client;
  let service: ServiceProcess | undefined;

  beforeAll(async () => {
    await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
    const databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
  }, 120_000);

  afterAll(async () => {
    await service?.crash();
    await db.end();
    for (const res of held.splice(0)) res.end();
    feed.closeAllConnections();
    await new Promise((r) => feed.close(r));
  }, 30_000);

  it('warns once per idle connection the pool lost, keeps answering, and reconnects', async () => {
    const started = service!;
    // Checks in parallel open connections of their own, which then sit idle in the pool.
    const checks = await Promise.all(Array.from({ length: 5 }, () => statusOf(started, '/api/ready')));
    expect(checks).toEqual([200, 200, 200, 200, 200]);

    const { rows } = await db.query<{ ended: boolean }>(
      `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'sarati-pg-pool' AND state = 'idle'`,
    );
    const ended = rows.filter((row) => row.ended).length;
    expect(ended).toBeGreaterThan(0);

    const lost = 'Lost an idle database connection: ';
    await heard(started, lost, ended);
    expect(warned(started, lost)).toEqual(Array.from({ length: ended }, () => `${lost}${TERMINATED}`));
    expect(await statusOf(started, '/api/health')).toBe(200);
    expect(await statusOf(started, '/api/ready')).toBe(200);
  });

  it("warns once when an activation's lock is lost with its connection mid stand-up, and the deploy still answers", async () => {
    const started = service!;
    const deployed = fetch(`${started.base}/api/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow_json: pollingDoc(`http://127.0.0.1:${(feed.address() as AddressInfo).port}/items`),
      }),
    }).then(
      (res) => res.status,
      (err: Error) => err.message,
    );
    // The stand-up's first poll is held, so the lock's connection sits idle, checked out of the pool.
    for (let i = 0; i < 100 && held.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(held).toHaveLength(1);
    const [activation] = (await db.query<{ id: string }>(`SELECT id FROM runtime_trigger_activations`)).rows;

    const { rows } = await db.query<{ ended: boolean }>(
      `SELECT pg_terminate_backend(l.pid) AS ended FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.classid = $1
          AND a.datname = current_database() AND a.application_name = 'sarati-pg-pool' AND a.state = 'idle'`,
      [ACTIVATION_LOCK_SPACE],
    );
    expect(rows).toEqual([{ ended: true }]);

    const lost = `Activation ${activation!.id} lost its lock with its database connection: `;
    await heard(started, lost, 1);
    held.splice(0).forEach((res) => res.writeHead(200, { 'content-type': 'application/json' }).end('[]'));
    expect(await deployed).toBe(201);
    expect(warned(started, lost)).toEqual([`${lost}${TERMINATED}`]);
    expect(await statusOf(started, '/api/health')).toBe(200);
    expect(await statusOf(started, '/api/ready')).toBe(200);
  });
});
