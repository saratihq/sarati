import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { NOT_RESUMABLE } from '../src/dbos/recovery-guard';
import { GOLDEN_DIR, restoreGoldenHistory } from './support/golden-history';
import { bootService, startService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;
const EXPOSED = [
  'inside-step-fan-out',
  'inside-wait-fan-out',
  'inside-timer-fan-out',
  'parked-after-fan-out',
  'shared-receive-wait-fan-out',
];
const RESUMABLE = ['linear-parked', 'parked-before-fan-out', 'agent-tool-calls', 'pins'];

interface RunRow {
  status: string;
  error: string | null;
}

/** A run recovered on the legacy engine resumes only when no step it recorded ran beside another (child processes, DBOS on, mock auth). */
describe('the recovery guard (e2e)', () => {
  let databaseUrl: string;
  let systemUrl: string;
  let db: Client;
  let dbos: Client;
  let service: ServiceProcess | undefined;
  const hits = new Map<string, number>();
  const fixture = createHttpServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    if (req.url === '/slow') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const base = (): string => `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${service!.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

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
    throw new Error(`never saw ${what}\n${service?.log().slice(-4_000) ?? ''}`);
  }

  const runOf = async (runId: string): Promise<RunRow | undefined> =>
    (
      await db.query<RunRow>(`SELECT status, error FROM runtime_runs WHERE id = $1`, [
        `${MOCK_USER_ID}:${runId}`,
      ])
    ).rows[0];
  const workflowOf = async (runId: string): Promise<string | undefined> =>
    (
      await dbos.query<{ status: string }>(
        `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
        [`${MOCK_USER_ID}:${runId}`],
      )
    ).rows[0]?.status;
  const openSteps = async (runId: string): Promise<unknown[]> =>
    (
      await db.query(
        `SELECT step_key FROM runtime_run_steps
          WHERE run_id = $1 AND (finished_at IS NULL OR waiting_topic IS NOT NULL OR claimed_at IS NOT NULL)`,
        [`${MOCK_USER_ID}:${runId}`],
      )
    ).rows;
  const decide = (runId: string, step_key: string): Promise<Response> =>
    post(`/api/runs/${runId}/events`, { topic: 'approval', step_key, payload: { d: runId } });

  async function reboot(between: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    await service?.crash();
    await between();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
  }

  // Recover each shape as its run id under a held table lock, releasing it once the guard has tried and waited twice.
  async function recoverUnderLock(
    runs: Record<string, string>,
    held: { url: string; statement: string; retries: string },
  ): Promise<void> {
    const { url, statement, retries } = held;
    await service?.crash();
    service = undefined;
    for (const [shape, runId] of Object.entries(runs)) await restoreGoldenHistory(db, dbos, shape, runId);
    const holder = new Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(statement);
      const started = await startService({ service: THIS_SERVICE, databaseUrl });
      service = started;
      await eventually(
        () => Promise.resolve(started.log().split(retries).length - 1),
        (seen) => seen >= 2,
        `the guard retrying: ${retries}`,
      );
      await holder.query('ROLLBACK');
      await started.answered;
    } finally {
      await holder.end();
    }
  }

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    systemUrl = sysUrl.toString();
    dbos = new Client({ connectionString: systemUrl });
    await dbos.connect();
    // Served once, the mock user has the org every restore moves its run into.
    expect((await fetch(`${service.base}/api/runs/waiting`)).ok).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await service?.crash();
    await dbos?.end();
    await db.end();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
  }, 30_000);

  describe('on the histories the build before left', () => {
    let report: string;
    let endedByReport: number;

    beforeAll(async () => {
      const recordedBase = /http:\/\/127\.0\.0\.1:\d+/.exec(
        readFileSync(join(GOLDEN_DIR, 'inside-step-fan-out.json'), 'utf8'),
      )![0];
      await reboot(async () => {
        for (const shape of [...EXPOSED, ...RESUMABLE]) {
          await restoreGoldenHistory(db, dbos, shape, shape, { [recordedBase]: base() });
        }
        ({ stdout: report } = await promisify(execFile)(
          process.execPath,
          ['-r', 'ts-node/register/transpile-only', 'src/scripts/legacy-report.cli.ts'],
          {
            cwd: THIS_SERVICE,
            env: { ...process.env, DATABASE_URL: databaseUrl, DBOS_SYSTEM_DATABASE_URL: '' },
          },
        ));
        endedByReport = (
          await db.query(`SELECT 1 FROM runtime_runs WHERE status = 'error' AND id = ANY($1)`, [
            [...EXPOSED, ...RESUMABLE].map((shape) => `${MOCK_USER_ID}:${shape}`),
          ])
        ).rows.length;
      });
    }, 90_000);

    it('reports, reading only, which runs in flight would resume and which would fail', () => {
      const lines = report.trim().split('\n');
      expect(lines[0]).toBe('Runs in flight, as of now; each is judged again when it recovers.');
      expect(lines).toHaveLength(RESUMABLE.length + EXPOSED.length + 2);
      for (const shape of RESUMABLE) expect(lines).toContain(`would resume  ${MOCK_USER_ID}:${shape}`);
      for (const shape of EXPOSED) {
        expect(
          lines.filter((line) => line.startsWith(`would fail    ${MOCK_USER_ID}:${shape}  (`)),
        ).toHaveLength(1);
      }
      expect(lines.at(-1)).toBe(`${RESUMABLE.length} would resume, ${EXPOSED.length} would fail.`);
      expect(endedByReport).toBe(0);
    });

    it('counts at boot how many runs in flight can resume and how many will fail', () => {
      expect(service!.log()).toContain(
        `Runs in flight at boot: ${RESUMABLE.length} can resume, ${EXPOSED.length} can't be resumed safely and will fail`,
      );
    });

    it.each(EXPOSED)('ends a run recorded %s in error, says why, and runs nothing again', async (shape) => {
      const run = await eventually(
        () => runOf(shape),
        (row) => row?.status === 'error',
        `${shape} ended`,
      );
      expect(run).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
      expect(
        await eventually(
          () => workflowOf(shape),
          (status) => status === 'ERROR',
          `${shape}'s workflow`,
        ),
      ).toBe('ERROR');
      expect(await openSteps(shape)).toEqual([]);
      expect(service!.log()).toContain(`Run ${MOCK_USER_ID}:${shape} can't be resumed`);
      expect(hits.get('/hold')).toBeUndefined();
    });

    it.each(RESUMABLE)('resumes a run recorded %s and runs it to its end', async (shape) => {
      await eventually(
        () => openSteps(shape),
        (rows) => rows.length === 1,
        `${shape} parked again`,
      );
      expect((await decide(shape, 'approve')).status).toBe(200);
      expect(
        await eventually(
          () => runOf(shape),
          (row) => row?.status === 'completed',
          `${shape} done`,
        ),
      ).toEqual({
        status: 'completed',
        error: null,
      });
    });
  });

  it('waits out a read the database refuses, then ends or resumes each run on what it reads', async () => {
    // Held on DBOS's table, not the app's: the app's boot reads its own tables and would wait the lock out unlogged.
    await recoverUnderLock(
      { 'linear-parked': 'held-read', 'inside-wait-fan-out': 'held-read-exposed' },
      {
        url: systemUrl,
        statement: 'LOCK TABLE dbos.operation_outputs IN ACCESS EXCLUSIVE MODE',
        retries: `Couldn't read the history of run ${MOCK_USER_ID}:held-read-exposed`,
      },
    );
    expect(
      await eventually(
        () => runOf('held-read-exposed'),
        (row) => row?.status === 'error',
        'held-read-exposed ended',
      ),
    ).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
    await eventually(
      () => openSteps('held-read'),
      (rows) => rows.length === 1,
      'held-read parked again',
    );
    expect(await runOf('held-read')).toMatchObject({ status: 'waiting' });
    expect((await decide('held-read', 'approve')).status).toBe(200);
    await eventually(
      () => runOf('held-read'),
      (row) => row?.status === 'completed',
      'held-read done',
    );
  }, 120_000);

  it('never refuses a run that ran nothing side by side for a lock on its history, and resumes it once it lifts', async () => {
    await service?.crash();
    service = undefined;
    await restoreGoldenHistory(db, dbos, 'linear-parked', 'held-app');
    const holder = new Client({ connectionString: databaseUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE runtime_run_steps IN ACCESS EXCLUSIVE MODE');
      const started = await startService({ service: THIS_SERVICE, databaseUrl });
      service = started;
      // Boot waits on this lock and logs nothing until it lifts: count the history reads queued on it, the boot count's first.
      const reads = new Set<string>();
      await eventually(
        async () => {
          const waiting = await db.query<{ pid: number; query_start: Date }>(
            `SELECT pid, query_start FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE 'SELECT step_key, kind, pinned FROM runtime_run_steps%'`,
          );
          for (const read of waiting.rows) reads.add(`${read.pid}@${read.query_start.toISOString()}`);
          return reads.size;
        },
        (count) => count >= 4,
        'the guard reading its history again',
      );
      await holder.query('ROLLBACK');
      await started.answered;
    } finally {
      await holder.end();
    }
    const log = service.log();
    expect(
      log.split(`Couldn't read the history of run ${MOCK_USER_ID}:held-app`).length - 1,
    ).toBeGreaterThanOrEqual(2);
    expect(log).not.toContain(`Run ${MOCK_USER_ID}:held-app can't be resumed`);
    await eventually(
      () => openSteps('held-app'),
      (rows) => rows.length === 1,
      'held-app parked again',
    );
    expect((await decide('held-app', 'approve')).status).toBe(200);
    expect(
      await eventually(
        () => runOf('held-app'),
        (row) => row?.status === 'completed',
        'held-app done',
      ),
    ).toEqual({ status: 'completed', error: null });
  }, 120_000);

  it('retries the write that ends a run it refuses while the table is held, then ends it', async () => {
    await recoverUnderLock(
      { 'inside-wait-fan-out': 'held-write' },
      {
        url: databaseUrl,
        statement: 'LOCK TABLE runtime_runs IN EXCLUSIVE MODE',
        retries: `Couldn't end run ${MOCK_USER_ID}:held-write`,
      },
    );
    expect(
      await eventually(
        () => runOf('held-write'),
        (row) => row?.status === 'error',
        'held-write ended',
      ),
    ).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
    expect(await openSteps('held-write')).toEqual([]);
  }, 120_000);

  it('resumes a run parked before its fan-out, then refuses it once a crash catches it inside', async () => {
    const get = (id: string) => ({
      kind: 'action',
      id,
      actionId: 'http.send_request',
      props: { method: 'GET', url: `${base()}/${id}` },
    });
    const nodes = [
      { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: WINDOW_MS },
      { kind: 'parallel', id: 'fork', branches: [[get('slow')], [get('fast')]] },
    ];
    expect((await post('/api/runs/async', { run_id: 'live', plan: { id: 'plan-live', nodes } })).status).toBe(
      201,
    );
    await eventually(
      () => openSteps('live'),
      (rows) => rows.length === 1,
      'live parked',
    );

    await reboot();
    await eventually(
      () => openSteps('live'),
      (rows) => rows.length === 1,
      'live parked again',
    );
    expect(await runOf('live')).toMatchObject({ status: 'waiting' });
    expect((await decide('live', 'approve')).status).toBe(200);
    await eventually(
      () => Promise.resolve([hits.get('/slow'), hits.get('/fast')]),
      ([slow, fast]) => slow === 1 && fast === 1,
      'the fan-out under way',
    );

    await reboot();
    expect(
      await eventually(
        () => runOf('live'),
        (row) => row?.status === 'error',
        'live ended',
      ),
    ).toEqual({
      status: 'error',
      error: NOT_RESUMABLE['side-by-side'],
    });
    expect([hits.get('/slow'), hits.get('/fast')]).toEqual([1, 1]);
  }, 120_000);
});
