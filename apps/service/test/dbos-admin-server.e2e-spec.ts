import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { NOT_RESUMABLE } from '../src/dbos/recovery-guard';
import { LEGACY_BUILD, restoreGoldenHistory } from './support/golden-history';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;
const APPROVAL = { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: WINDOW_MS };

interface RunRow {
  status: string;
  error: string | null;
}

/** The service runs DBOS with no admin API of its own, and recovers runs without one (child processes, DBOS on, mock auth). */
describe('DBOS without its admin server (e2e)', () => {
  let databaseUrl: string;
  let db: Client;
  let dbos: Client;
  let service: ServiceProcess | undefined;

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
  const parked = async (runId: string): Promise<unknown[]> =>
    (
      await db.query(
        `SELECT step_key FROM runtime_run_steps WHERE run_id = $1 AND waiting_topic IS NOT NULL`,
        [`${MOCK_USER_ID}:${runId}`],
      )
    ).rows;
  const parkedAgain = (runId: string): Promise<unknown[]> =>
    eventually(
      () => parked(runId),
      (rows) => rows.length === 1,
      `${runId} parked`,
    );

  // The boot log can reach this process after the service answers; the launch line comes after everything the launch wrote.
  const bootLog = (): Promise<string> =>
    eventually(
      () => Promise.resolve(service!.log()),
      (log) => log.includes('DBOS launched ('),
      'the DBOS launch line',
    );

  // A bind lost to another process on DBOS's port leaves only a warning in the log.
  async function listensOnItsPortAlone(): Promise<void> {
    expect(await service!.listeningPorts()).toEqual([Number(new URL(service!.base).port)]);
    expect(await bootLog()).not.toMatch(/admin server/i);
  }

  async function startParked(runId: string): Promise<void> {
    const res = await post('/api/runs/async', {
      run_id: runId,
      plan: { id: `plan-${runId}`, nodes: [APPROVAL] },
    });
    expect(res.status).toBe(201);
    await parkedAgain(runId);
  }

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const systemUrl = new URL(databaseUrl);
    systemUrl.pathname = `${systemUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: systemUrl.toString() });
    await dbos.connect();
    // Served once, the mock user has the org a restored run moves into.
    expect((await fetch(`${service.base}/api/runs/waiting`)).ok).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await service?.crash();
    await dbos?.end();
    await db?.end();
  }, 30_000);

  it('listens on its PORT alone with a run in flight, and never tries to start an admin server', async () => {
    await startParked(`held-${randomUUID()}`);
    await listensOnItsPortAlone();
  });

  it('resumes after a crash a run this build started and one an earlier build started, and judges another from the steps it recorded', async () => {
    const current = `resumed-${randomUUID()}`;
    await startParked(current);
    await service!.crash();
    service = undefined;
    await restoreGoldenHistory(db, dbos, `${LEGACY_BUILD}/linear-parked`, 'earlier');
    await restoreGoldenHistory(db, dbos, `${LEGACY_BUILD}/parked-after-fan-out`, 'earlier-fanned');
    service = await bootService({ service: THIS_SERVICE, databaseUrl });

    expect(await bootLog()).toContain(
      "Runs an earlier version started, in flight at boot: 1 can resume, 1 can't be resumed safely and will fail, 0 had already ended",
    );
    expect(
      await eventually(
        () => runOf('earlier-fanned'),
        (row) => row?.status === 'error',
        'earlier-fanned ended',
      ),
    ).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
    for (const runId of [current, 'earlier']) {
      await parkedAgain(runId);
      const decided = await post(`/api/runs/${runId}/events`, {
        topic: 'approval',
        step_key: 'approve',
        payload: { d: runId },
      });
      expect(decided.status).toBe(200);
      expect(
        await eventually(
          () => runOf(runId),
          (row) => row?.status === 'completed',
          `${runId} done`,
        ),
      ).toEqual({ status: 'completed', error: null });
    }
    await listensOnItsPortAlone();
  }, 120_000);
});
