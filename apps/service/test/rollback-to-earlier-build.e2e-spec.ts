import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from 'pg';

import { PARK_DELAY_ABOVE_MS } from '../src/runtime/timer-wait';
import { unpackBuild, type EarlierBuild } from './support/earlier-build';
import { goldenBuild } from './support/golden-history';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;
const LAPSING_MS = 4_000;
const PARKED_DELAY_MS = PARK_DELAY_ABOVE_MS + 1_000;

interface RunRow {
  run_id: string;
  status: string;
  error: string | null;
  finished_at: Date | null;
  decided_by: string | null;
}

/** v0.2.24, the build this one replaces, booted on a run this one started and booted back over it (child processes, DBOS on, mock auth). */
describe('a run this version starts, across a rollback to v0.2.24 and back (e2e)', () => {
  let earlier: EarlierBuild;
  let databaseUrl: string;
  let db: Client;
  let dbos: Client | undefined;
  let service: ServiceProcess | undefined;
  let slowCalls = 0;
  const fixture = createHttpServer((req) => {
    if (req.url === '/slow') slowCalls += 1;
  });

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
    tries = 300,
  ): Promise<T> {
    for (let i = 0; i < tries; i++) {
      const value = await read().catch(() => undefined);
      if (value !== undefined && done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}\n${service?.log().slice(-4_000) ?? ''}`);
  }

  const runs = async (): Promise<Record<string, RunRow>> =>
    Object.fromEntries(
      (
        await db.query<RunRow>(
          `SELECT run_id, status, error, finished_at, decided_by FROM runtime_runs ORDER BY run_id`,
        )
      ).rows.map((r) => [r.run_id, r]),
    );
  const workflows = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await dbos!.query<{ workflow_uuid: string; status: string }>(
          `SELECT workflow_uuid, status FROM dbos.workflow_status`,
        )
      ).rows.map((r) => [r.workflow_uuid.slice(MOCK_USER_ID.length + 1), r.status]),
    );

  beforeAll(async () => {
    earlier = unpackBuild(goldenBuild());
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  }, 300_000);

  afterAll(async () => {
    await service?.crash();
    await dbos?.end();
    await db.end();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
    earlier.remove();
  }, 60_000);

  it('is listed and decided on the build before, ended there past the max or its window, and picked up where it was on coming back, a Wait step waking then', async () => {
    const slow = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/slow`;
    const approve = (timeoutMs: number) => [
      { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs },
    ];
    const plans: Record<string, unknown[]> = {
      decided: approve(WINDOW_MS),
      untouched: approve(WINDOW_MS),
      lapsed: approve(LAPSING_MS),
      overdue: [
        { kind: 'action', id: 'call', actionId: 'http.send_request', props: { method: 'GET', url: slow } },
      ],
      timed: [{ kind: 'delay', id: 'pause', ms: PARKED_DELAY_MS }],
      'timed-overdue': [{ kind: 'delay', id: 'pause', ms: PARKED_DELAY_MS }],
    };

    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: sysUrl.toString() });
    await dbos.connect();
    for (const [runId, nodes] of Object.entries(plans)) {
      expect(
        (await post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } })).status,
      ).toBe(201);
    }
    await eventually(
      () =>
        db.query<{ topic: string }>(
          `SELECT split_part(waiting_topic, ':', 2) AS topic FROM runtime_run_steps
            WHERE waiting_topic IS NOT NULL AND finished_at IS NULL`,
        ),
      (res) =>
        res.rows.filter((r) => r.topic === '').length === 3 &&
        res.rows.filter((r) => r.topic === 'timer').length === 2 &&
        slowCalls === 1,
      'three waits and two Wait steps parked, and the call in flight',
    );
    await service.crash();
    await new Promise((r) => setTimeout(r, LAPSING_MS));
    // Its time long up, as the build before reads it: the test can't wait that long.
    await db.query(
      `UPDATE runtime_run_steps SET waiting_timeout_at = now() - interval '1 hour' WHERE run_id = $1`,
      [`${MOCK_USER_ID}:timed-overdue`],
    );

    service = await bootService({
      service: earlier.service,
      earlier: true,
      databaseUrl,
      env: { RUN_MAX_DURATION_SECONDS: '2' },
    });
    for (const runId of Object.keys(plans)) {
      expect(service.log()).toContain(
        `Recovery of workflow ${MOCK_USER_ID}:${runId} failed: Cannot find workflow function`,
      );
    }
    const ended = await eventually(
      runs,
      (now) =>
        now.lapsed?.status === 'error' &&
        now.overdue?.status === 'error' &&
        now['timed-overdue']?.status === 'error',
      'the build before ending the lapsed, the overdue and the timed-overdue run',
    );
    expect(ended).toMatchObject({
      decided: { status: 'waiting' },
      untouched: { status: 'waiting' },
      lapsed: { error: 'Approval window expired before a decision was recorded.' },
      timed: { status: 'waiting' },
      'timed-overdue': {
        error: 'The run never woke from a scheduled wait — the worker was down when it was due.',
      },
    });
    const inbox = (await (await fetch(`${service.base}/api/runs/waiting`)).json()) as {
      runs: Array<{ run_id: string }>;
    };
    expect(inbox.runs.map((r) => r.run_id).sort()).toEqual(['decided', 'untouched']);
    expect(
      (
        await post('/api/runs/decided/events', {
          topic: 'approval',
          step_key: 'approve',
          payload: { by: 'earlier' },
        })
      ).status,
    ).toBe(200);
    await service.crash();

    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const back = await eventually(
      runs,
      (now) => now.decided?.status === 'completed',
      'the decided run completing',
    );
    expect(back.decided!.decided_by).toBe(MOCK_USER_ID);
    expect(back.lapsed).toEqual(ended.lapsed);
    expect(back.overdue).toEqual(ended.overdue);
    await eventually(
      workflows,
      (now) =>
        now.lapsed === 'ERROR' &&
        now.overdue === 'ERROR' &&
        now['timed-overdue'] === 'ERROR' &&
        now.decided === 'SUCCESS',
      'the ended runs’ workflows stopping before running anything',
    );
    expect(await runs()).toMatchObject({
      lapsed: ended.lapsed,
      overdue: ended.overdue,
      'timed-overdue': ended['timed-overdue'],
    });
    expect(slowCalls).toBe(1);

    expect(
      (
        await post('/api/runs/untouched/events', {
          topic: 'approval',
          step_key: 'approve',
          payload: { by: 'this' },
        })
      ).status,
    ).toBe(200);
    await eventually(runs, (now) => now.untouched?.status === 'completed', 'the untouched run completing');
    await eventually(
      runs,
      (now) => now.timed?.status === 'completed',
      'the Wait step waking when its time comes',
      PARKED_DELAY_MS / 100,
    );
  }, 240_000);
});
