import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;

interface Parked {
  step_key: string;
  waiting_since: Date;
  waiting_timeout_at: Date;
}

/** The real service in its own process, killed with SIGKILL and booted again on the same database (DBOS on). */
describe('waits across a crash and a reboot (e2e, child process, DBOS on, mock auth)', () => {
  let db: Client;
  let dbos: Client;
  let databaseUrl: string;
  let port: number;
  let service: ChildProcess | undefined;
  let log = '';

  const url = (path: string): string => `http://127.0.0.1:${port}${path}`;
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const json = async (path: string): Promise<Record<string, unknown>> =>
    (await (await fetch(url(path))).json()) as Record<string, unknown>;

  async function eventually<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const value = await read().catch(() => undefined);
      if (value !== undefined && done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}\n${log.slice(-4_000)}`);
  }

  async function boot(): Promise<void> {
    log = '';
    service = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/main.ts'], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DBOS_SYSTEM_DATABASE_URL: '',
        PORT: String(port),
        MOCK_AUTH: 'true',
        PGBOSS_ENABLED: 'false',
        DBOS_ENABLED: 'true',
        THROTTLE_LIMIT: '10000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    service.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    await eventually(
      () => fetch(url('/api/health')),
      (res) => res.ok,
      'the service answering',
    );
  }

  async function crash(): Promise<void> {
    const dead = new Promise((r) => service!.once('exit', r));
    service!.kill('SIGKILL');
    await dead;
  }

  const parkedIn = async (runId: string): Promise<Parked[]> =>
    (
      await db.query<Parked>(
        `SELECT s.step_key, s.waiting_since, s.waiting_timeout_at FROM runtime_run_steps s
          WHERE s.run_id = $1 AND s.waiting_topic IS NOT NULL ORDER BY s.step_key`,
        [`${MOCK_USER_ID}:${runId}`],
      )
    ).rows;

  const recoveries = async (runIds: string[]): Promise<number[]> =>
    (
      await dbos.query<{ recovery_attempts: string }>(
        `SELECT recovery_attempts FROM dbos.workflow_status WHERE workflow_uuid = ANY($1) ORDER BY workflow_uuid`,
        [runIds.map((id) => `${MOCK_USER_ID}:${id}`)],
      )
    ).rows.map((r) => Number(r.recovery_attempts));

  const completed = (runId: string): Promise<Record<string, unknown>> =>
    eventually(
      () => json(`/api/runs/${runId}`),
      (d) => d.status === 'completed',
      `${runId} completed`,
    );

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    await boot();
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: sysUrl.toString() });
    await dbos.connect();
  }, 90_000);

  afterAll(async () => {
    if (service && service.exitCode === null) await crash();
    await dbos?.end();
    await db.end();
  }, 30_000);

  it('keeps a pending wait and its deadline, never parks an answered one again, and stays up', async () => {
    const start = (runId: string, nodes: unknown[]) =>
      post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } });
    const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
    expect((await start('pending', [approval('approve')])).status).toBe(201);
    expect((await start('sequence', [approval('first'), approval('second')])).status).toBe(201);

    await eventually(
      () => parkedIn('pending'),
      (p) => p.length === 1,
      'pending parked',
    );
    await eventually(
      () => parkedIn('sequence'),
      (p) => p[0]?.step_key === 'first',
      'first parked',
    );
    expect(
      (await post('/api/runs/sequence/events', { topic: 'approval', payload: { decision: 'one' } })).status,
    ).toBe(200);
    const before = {
      pending: await parkedIn('pending'),
      sequence: await eventually(
        () => parkedIn('sequence'),
        (p) => p[0]?.step_key === 'second',
        'second parked',
      ),
    };
    const attempts = await recoveries(['pending', 'sequence']);

    await crash();
    await boot();
    await eventually(
      () => recoveries(['pending', 'sequence']),
      (now) => now.every((n, i) => n > attempts[i]!),
      'both runs recovered',
    );

    const listed = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const inbox = (await json('/api/runs/waiting')).runs as Array<{ run_id: string; step_key: string }>;
      for (const row of inbox) listed.add(`${row.run_id}/${row.step_key}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect([...listed].sort()).toEqual(['pending/approve', 'sequence/second']);
    expect(await parkedIn('pending')).toEqual(before.pending);
    expect(await parkedIn('sequence')).toEqual(before.sequence);

    expect(
      (await post('/api/runs/pending/events', { topic: 'approval', payload: { decision: 'yes' } })).status,
    ).toBe(200);
    expect(
      (await post('/api/runs/sequence/events', { topic: 'approval', payload: { decision: 'two' } })).status,
    ).toBe(200);
    expect((await completed('pending')).outputs).toMatchObject({ approve: { decision: 'yes' } });
    expect((await completed('sequence')).outputs).toMatchObject({
      first: { decision: 'one' },
      second: { decision: 'two' },
    });
    expect(service!.exitCode).toBeNull();
    expect((await fetch(url('/api/health'))).ok).toBe(true);
  }, 120_000);
});
