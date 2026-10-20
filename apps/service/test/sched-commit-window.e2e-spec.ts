import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from 'pg';

import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const HOLD = 4242;

/** Design §5.4 on real DBOS: no op is issued on a settle order until its `sched` step commits (child process, SIGKILL). */
describe('the sched commit window (e2e, real DBOS, child process)', () => {
  let databaseUrl: string;
  let db: Client;
  let dbos: Client;
  let service: ServiceProcess | undefined;
  const hits = new Map<string, number>();
  const fixture = createHttpServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    setTimeout(
      () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      },
      req.url === '/a' ? 300 : 0,
    );
  });

  const eventually = async <T>(what: string, read: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    for (let i = 0; i < 300; i++) {
      const value = await read().catch(() => undefined);
      if (value !== undefined && done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}\n${service?.log().slice(-4_000) ?? ''}`);
  };
  const opNames = async (runKey: string): Promise<string[]> =>
    (
      await dbos.query<{ function_name: string }>(
        `SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
        [runKey],
      )
    ).rows.map((r) => r.function_name);

  beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: sysUrl.toString() });
    await dbos.connect();
  }, 90_000);

  afterAll(async () => {
    await service?.crash();
    await dbos?.end();
    await db?.end();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
  }, 30_000);

  it('issues nothing on an unrecorded settle order, so a run killed before its sched commits resumes with no mis-pair', async () => {
    const runKey = `${MOCK_USER_ID}:window`;
    const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const get = (id: string) => ({
      kind: 'action',
      id,
      actionId: 'http.send_request',
      props: { method: 'GET', url: `${base}/${id}` },
    });
    await dbos.query(
      `CREATE FUNCTION hold_sched() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.function_name LIKE 'sched|%' THEN PERFORM pg_advisory_xact_lock(${HOLD}); END IF;
           RETURN NEW;
         END $$`,
    );
    await dbos.query(
      `CREATE TRIGGER hold_sched BEFORE INSERT ON dbos.operation_outputs FOR EACH ROW EXECUTE FUNCTION hold_sched()`,
    );
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    const lock = new Client({ connectionString: sysUrl.toString() });
    await lock.connect();
    try {
      await lock.query(`SELECT pg_advisory_lock(${HOLD})`);
      const nodes = [
        {
          kind: 'parallel',
          id: 'fork',
          branches: [
            [get('a'), get('a2')],
            [get('b'), get('b2')],
          ],
        },
      ];
      const started = await fetch(`${service!.base}/api/runs/async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: 'window', plan: { id: 'plan-window', nodes } }),
      });
      expect(started.status).toBe(201);
      await eventually(
        'the sched record held, with both bodies recorded',
        async () => ({
          held: (
            await dbos.query(
              `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${HOLD}`,
            )
          ).rows.length,
          ops: await opNames(runKey),
        }),
        ({ held, ops }) => held === 1 && ops.length === 2,
      );
      // `b` settled first; while that order is unrecorded, neither lane goes on.
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await opNames(runKey)).sort()).toEqual([
        'step|plan-window:fork|0/a',
        'step|plan-window:fork|1/b',
      ]);
      expect([hits.get('/a2'), hits.get('/b2')]).toEqual([undefined, undefined]);

      await service!.crash();
      await dbos.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${HOLD}`,
      );
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(${HOLD})`);
      await lock.end();
      await dbos.query(`DROP TRIGGER IF EXISTS hold_sched ON dbos.operation_outputs`);
      await dbos.query(`DROP FUNCTION IF EXISTS hold_sched()`);
    }
    expect((await opNames(runKey)).filter((name) => name.startsWith('sched|'))).toEqual([]);

    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const run = await eventually(
      'the resumed run ended',
      () =>
        db.query<{ status: string; error: string | null }>(
          `SELECT status, error FROM runtime_runs WHERE id = $1`,
          [runKey],
        ),
      (res) => res.rows[0]?.status === 'completed' || res.rows[0]?.status === 'error',
    );
    expect(run.rows).toEqual([{ status: 'completed', error: null }]);
    expect(Object.fromEntries(['/a', '/b', '/a2', '/b2'].map((path) => [path, hits.get(path)]))).toEqual({
      '/a': 1,
      '/b': 1,
      '/a2': 1,
      '/b2': 1,
    });
  }, 120_000);
});
