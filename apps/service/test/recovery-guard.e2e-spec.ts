import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { NOT_RESUMABLE } from '../src/dbos/recovery-guard';
import { RUN_PLAN_V2_WORKFLOW, RUN_PLAN_WORKFLOW } from '../src/dbos/run-plan-workflow';
import { failedNodeIdOf, NOT_RESUMED_STEP_ERROR } from '../src/runs/run-failure';
import { GOLDEN_DIR, LEGACY_BUILD, restoreGoldenHistory } from './support/golden-history';
import { bootService, startService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;
// v0.2.24, the last release whose runs start on the legacy engine, and v0.2.23, the release before it, whose waits on one topic all share a receive.
const LATEST = LEGACY_BUILD;
const RELEASED = '0af0a76';
const EXPOSED = [
  'inside-step-fan-out',
  'inside-wait-fan-out',
  'inside-timer-fan-out',
  'parked-after-fan-out',
];
const RESUMABLE = ['linear-parked', 'parked-before-fan-out', 'agent-tool-calls', 'pins'];
const recorded = (shapes: string[], latestOnly: string[] = []): string[] => [
  ...[...shapes, ...latestOnly].map((shape) => `${LATEST}/${shape}`),
  ...shapes.map((shape) => `${RELEASED}/${shape}`),
];
const RECORDED_EXPOSED = recorded(EXPOSED, ['shared-receive-wait-fan-out']);
const RECORDED_RESUMABLE = recorded(RESUMABLE);
const runIdOf = (golden: string): string => golden.replace('/', '-');
// Runs this build's DBOS never recovers, so neither the boot count nor the report lists them.
const ELSEWHERE = [
  ['uncounted-version', 'application_version', 'orchestr-0'],
  ['uncounted-executor', 'executor_id', 'replica-b'],
] as const;
const HISTORY_READ = 'SELECT step_key, kind, pinned FROM runtime_run_steps';
const LOCK_RUN_STEPS = 'LOCK TABLE runtime_run_steps IN ACCESS EXCLUSIVE MODE';
const seen = (log: string, line: string): number => log.split(line).length - 1;

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
  let slowAnswers = false;
  const fixture = createHttpServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    if (req.url === '/slow' && !slowAnswers) return;
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
  const stepsWhere = async (runId: string, where: string, params: unknown[] = []): Promise<unknown[]> =>
    (
      await db.query(`SELECT step_key FROM runtime_run_steps WHERE run_id = $1 AND (${where})`, [
        `${MOCK_USER_ID}:${runId}`,
        ...params,
      ])
    ).rows;
  const parkedSteps = (runId: string): Promise<unknown[]> =>
    stepsWhere(runId, 'waiting_topic IS NOT NULL OR claimed_at IS NOT NULL');
  const stopped = (runId: string): Promise<unknown[]> =>
    stepsWhere(runId, `status = 'error' AND error = $2`, [NOT_RESUMED_STEP_ERROR]);
  // What the guard's end leaves: no wait or claim, nothing under way, and no step failed of its own, so no node is named as the failure.
  const endedUnresumed = async (runId: string): Promise<void> => {
    expect(await parkedSteps(runId)).toEqual([]);
    expect(await stepsWhere(runId, `status = 'running'`)).toEqual([]);
    expect(
      await stepsWhere(runId, `status = 'error' AND error IS DISTINCT FROM $2`, [NOT_RESUMED_STEP_ERROR]),
    ).toEqual([]);
    const run = (await (await fetch(`${service!.base}/api/runs/${runId}`)).json()) as {
      steps: Array<Record<string, unknown>>;
    };
    expect(failedNodeIdOf(run.steps)).toBeNull();
  };
  const decide = (runId: string, step_key: string): Promise<Response> =>
    post(`/api/runs/${runId}/events`, { topic: 'approval', step_key, payload: { d: runId } });

  async function startParked(runId: string): Promise<void> {
    const nodes = [{ kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: WINDOW_MS }];
    expect(
      (await post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } })).status,
    ).toBe(201);
    await eventually(
      () => parkedSteps(runId),
      (rows) => rows.length === 1,
      `${runId} parked`,
    );
    const [workflow] = (
      await dbos.query<{ name: string }>(`SELECT name FROM dbos.workflow_status WHERE workflow_uuid = $1`, [
        `${MOCK_USER_ID}:${runId}`,
      ])
    ).rows;
    expect(workflow?.name).toBe(RUN_PLAN_V2_WORKFLOW);
  }

  async function reboot(between: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    await service?.crash();
    await between();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
  }

  // Recover each shape as its run id, and no other legacy run, under a held table lock released once `held` settles.
  async function recoverUnderLock(
    runs: Record<string, string>,
    lock: { url: string; statement: string },
    held: (started: ServiceProcess) => Promise<unknown>,
  ): Promise<void> {
    await service?.crash();
    service = undefined;
    await dbos.query(
      `UPDATE dbos.workflow_status SET status = 'CANCELLED' WHERE name = $1 AND status = 'PENDING'`,
      [RUN_PLAN_WORKFLOW],
    );
    for (const [shape, runId] of Object.entries(runs)) await restoreGoldenHistory(db, dbos, shape, runId);
    const holder = new Client({ connectionString: lock.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(lock.statement);
      const started = await startService({ service: THIS_SERVICE, databaseUrl });
      service = started;
      await held(started);
      await holder.query('ROLLBACK');
      await started.answered;
    } finally {
      await holder.end();
    }
  }
  const retried =
    (line: string) =>
    (started: ServiceProcess): Promise<number> =>
      eventually(
        () => Promise.resolve(seen(started.log(), line)),
        (count) => count >= 2,
        `the guard retrying: ${line}`,
      );

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

  describe('on the histories the builds before left', () => {
    const CLAIMED_AT = '2026-10-20T08:00:00.000Z';
    const SEQUENCED = 'sequenced-in-flight';
    const BOOT_COUNT = `Runs v0.2.24 or earlier started, in flight at boot: ${RECORDED_RESUMABLE.length} can resume, ${RECORDED_EXPOSED.length + 1} can't be resumed safely and will fail, 1 had already ended`;
    const judged = [...RECORDED_EXPOSED, ...RECORDED_RESUMABLE].map(runIdOf);
    let report: string;
    let endedByReport: number;

    beforeAll(async () => {
      // Each build called the HTTP fixture at its own address.
      const fixtureOf = (build: string): Record<string, string> => ({
        [/http:\/\/127\.0\.0\.1:\d+/.exec(
          readFileSync(join(GOLDEN_DIR, build, 'inside-step-fan-out.json'), 'utf8'),
        )![0]]: base(),
      });
      await startParked(SEQUENCED);
      await reboot(async () => {
        for (const golden of [...RECORDED_EXPOSED, ...RECORDED_RESUMABLE]) {
          await restoreGoldenHistory(db, dbos, golden, runIdOf(golden), fixtureOf(golden.split('/')[0]!));
        }
        await restoreGoldenHistory(db, dbos, `${LATEST}/parked-after-fan-out`, 'claimed');
        await db.query(
          `UPDATE runtime_run_steps SET claimed_by = $2, claimed_at = $3, claimed_payload = '{"d":1}'
            WHERE run_id = $1 AND step_key = 'approve'`,
          [`${MOCK_USER_ID}:claimed`, MOCK_USER_ID, CLAIMED_AT],
        );
        await restoreGoldenHistory(db, dbos, `${LATEST}/linear-parked`, 'already-ended');
        await db.query(
          `UPDATE runtime_runs SET status = 'error', error = 'Ended before the upgrade', finished_at = now(),
                  waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL
            WHERE id = $1`,
          [`${MOCK_USER_ID}:already-ended`],
        );
        // Recorded under another DBOS_APP_VERSION, and by another executor: DBOS recovers neither as this build launches.
        for (const [runId, column, value] of ELSEWHERE) {
          await restoreGoldenHistory(db, dbos, `${LATEST}/linear-parked`, runId);
          await dbos.query(`UPDATE dbos.workflow_status SET ${column} = $2 WHERE workflow_uuid = $1`, [
            `${MOCK_USER_ID}:${runId}`,
            value,
          ]);
        }
        // As an upgrade does: this build migrates what earlier builds left, then starts on it.
        await promisify(execFile)(process.execPath, ['scripts/migrate-db.mjs'], {
          cwd: THIS_SERVICE,
          env: { ...process.env, DATABASE_URL: databaseUrl },
        });
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
            [...judged, 'claimed'].map((runId) => `${MOCK_USER_ID}:${runId}`),
          ])
        ).rows.length;
      });
    }, 120_000);

    it('reports, reading only, which runs v0.2.24 or earlier started would resume, which would fail and which had ended', () => {
      const lines = report.trim().split('\n');
      const failing = RECORDED_EXPOSED.length + 1;
      expect(lines[0]).toBe(
        'Runs v0.2.24 or earlier started, in flight as of now; each is judged again when it recovers.',
      );
      expect(lines).toHaveLength(RECORDED_RESUMABLE.length + failing + 1 + 2);
      for (const golden of RECORDED_RESUMABLE) {
        expect(lines).toContain(`would resume  ${MOCK_USER_ID}:${runIdOf(golden)}`);
      }
      for (const runId of [...RECORDED_EXPOSED.map(runIdOf), 'claimed']) {
        expect(
          lines.filter((line) => line.startsWith(`would fail    ${MOCK_USER_ID}:${runId}  (`)),
        ).toHaveLength(1);
      }
      expect(lines).toContain(`already ended ${MOCK_USER_ID}:already-ended`);
      for (const [runId] of ELSEWHERE) expect(report).not.toContain(`${MOCK_USER_ID}:${runId}`);
      expect(lines.at(-1)).toBe(
        `${RECORDED_RESUMABLE.length} would resume, ${failing} would fail, 1 had already ended.`,
      );
      expect(endedByReport).toBe(0);
    });

    it('counts at boot how many runs v0.2.24 or earlier started can resume, how many will fail and how many had ended', () => {
      expect(service!.log()).toContain(BOOT_COUNT);
    });

    it('leaves a run v0.2.25 or later started out of the report and the boot count, and resumes it', async () => {
      expect(report).not.toContain(`${MOCK_USER_ID}:${SEQUENCED}`);
      expect(service!.log()).toContain(BOOT_COUNT);
      await eventually(
        () => parkedSteps(SEQUENCED),
        (rows) => rows.length === 1,
        `${SEQUENCED} parked again`,
      );
      expect((await decide(SEQUENCED, 'approve')).status).toBe(200);
      expect(
        await eventually(
          () => runOf(SEQUENCED),
          (row) => row?.status === 'completed',
          `${SEQUENCED} done`,
        ),
      ).toEqual({ status: 'completed', error: null });
    });

    it.each(RECORDED_EXPOSED)(
      'ends a run recorded as %s in error, says why, and runs nothing again',
      async (golden) => {
        const runId = runIdOf(golden);
        const run = await eventually(
          () => runOf(runId),
          (row) => row?.status === 'error',
          `${runId} ended`,
        );
        expect(run).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
        expect(
          await eventually(
            () => workflowOf(runId),
            (status) => status === 'ERROR',
            `${runId}'s workflow`,
          ),
        ).toBe('ERROR');
        await endedUnresumed(runId);
        expect(await stopped(runId)).not.toEqual([]);
        expect(service!.log()).toContain(`Run ${MOCK_USER_ID}:${runId} can't be resumed`);
        expect(hits.get('/hold')).toBeUndefined();
      },
    );

    it('ends a run it refuses with a decision claimed on it, keeping who decided on the wait and the run', async () => {
      const scoped = `${MOCK_USER_ID}:claimed`;
      await eventually(
        () => runOf('claimed'),
        (row) => row?.status === 'error',
        'claimed ended',
      );
      await endedUnresumed('claimed');
      const credit = await db.query<{
        step: string | null;
        at: Date | null;
        slot: string | null;
        slot_at: Date | null;
      }>(
        `SELECT s.decided_by AS step, s.decided_at AS at, r.decided_by AS slot, r.decided_at AS slot_at
           FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
          WHERE s.run_id = $1 AND s.step_key = 'approve'`,
        [scoped],
      );
      const at = new Date(CLAIMED_AT);
      expect(credit.rows).toEqual([{ step: MOCK_USER_ID, at, slot: MOCK_USER_ID, slot_at: at }]);
    });

    it('leaves a run whose row had already ended as it ended, and runs nothing for it', async () => {
      expect(
        await eventually(
          () => workflowOf('already-ended'),
          (status) => status === 'ERROR',
          "already-ended's workflow",
        ),
      ).toBe('ERROR');
      expect(await runOf('already-ended')).toEqual({ status: 'error', error: 'Ended before the upgrade' });
      expect(service!.log()).not.toContain(`Run ${MOCK_USER_ID}:already-ended can't be resumed`);
    });

    it.each(RECORDED_RESUMABLE)('resumes a run recorded as %s and runs it to its end', async (golden) => {
      const runId = runIdOf(golden);
      await eventually(
        () => parkedSteps(runId),
        (rows) => rows.length === 1,
        `${runId} parked again`,
      );
      expect((await decide(runId, 'approve')).status).toBe(200);
      expect(
        await eventually(
          () => runOf(runId),
          (row) => row?.status === 'completed',
          `${runId} done`,
        ),
      ).toEqual({
        status: 'completed',
        error: null,
      });
    });
  });

  it('stays up when the database ends the connection it reads histories on, leaving a parked run waiting', async () => {
    // Ended only while the guard waits on the lock for the run's rows: its DBOS read done, its connection sits idle in the pool.
    await recoverUnderLock(
      { [`${LATEST}/parked-before-fan-out`]: 'dropped' },
      { url: databaseUrl, statement: LOCK_RUN_STEPS },
      () =>
        eventually(
          async () =>
            (
              await db.query<{ ended: boolean }>(
                `SELECT pg_terminate_backend(guard.pid) AS ended FROM pg_stat_activity guard
                  WHERE guard.datname = $1 AND guard.application_name = 'sarati-recovery-guard'
                    AND guard.state = 'idle'
                    AND EXISTS (SELECT 1 FROM pg_stat_activity app
                                 WHERE app.datname = current_database() AND app.wait_event_type = 'Lock'
                                   AND starts_with(app.query, $2) AND app.query_start > guard.state_change)`,
                [new URL(systemUrl).pathname.slice(1), HISTORY_READ],
              )
            ).rows.filter((row) => row.ended).length,
          (ended) => ended > 0,
          "the guard's idle connection ended",
        ),
    );
    const started = service!;
    await eventually(
      () => Promise.resolve(started.log()),
      (log) => log.includes('The recovery guard lost a connection'),
      'the guard hearing its connection end',
    );
    expect((await fetch(`${started.base}/api/runs/waiting`)).ok).toBe(true);
    expect(await runOf('dropped')).toMatchObject({ status: 'waiting' });
    expect((await decide('dropped', 'approve')).status).toBe(200);
    expect(
      await eventually(
        () => runOf('dropped'),
        (row) => row?.status === 'completed',
        'dropped done',
      ),
    ).toEqual({ status: 'completed', error: null });
  }, 120_000);

  it('waits out a read the database refuses, then ends or resumes each run on what it reads', async () => {
    // Held on DBOS's table, not the app's: the app's boot reads its own tables and would wait the lock out unlogged.
    await recoverUnderLock(
      { [`${LATEST}/linear-parked`]: 'held-read', [`${LATEST}/inside-wait-fan-out`]: 'held-read-exposed' },
      { url: systemUrl, statement: 'LOCK TABLE dbos.operation_outputs IN ACCESS EXCLUSIVE MODE' },
      retried(`Couldn't read the history of run ${MOCK_USER_ID}:held-read-exposed`),
    );
    expect(
      await eventually(
        () => runOf('held-read-exposed'),
        (row) => row?.status === 'error',
        'held-read-exposed ended',
      ),
    ).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
    await eventually(
      () => parkedSteps('held-read'),
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
    // Boot waits on this lock and logs nothing until it lifts: count the history reads queued on it, all held-app's, the boot count's first.
    const reads = new Set<string>();
    await recoverUnderLock(
      { [`${LATEST}/linear-parked`]: 'held-app' },
      { url: databaseUrl, statement: LOCK_RUN_STEPS },
      () =>
        eventually(
          async () => {
            const waiting = await db.query<{ pid: number; query_start: Date }>(
              `SELECT pid, query_start FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock' AND starts_with(query, $1)`,
              [HISTORY_READ],
            );
            for (const read of waiting.rows) reads.add(`${read.pid}@${read.query_start.toISOString()}`);
            return reads.size;
          },
          (count) => count >= 4,
          'the guard reading its history again',
        ),
    );
    await eventually(
      () => parkedSteps('held-app'),
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
    // The lines the boot held back reach the log after it answers.
    const log = await eventually(
      () => Promise.resolve(service!.log()),
      (lines) => seen(lines, `Couldn't read the history of run ${MOCK_USER_ID}:held-app`) >= 2,
      "the guard's tries the lock refused",
    );
    expect(log).not.toContain(`Run ${MOCK_USER_ID}:held-app can't be resumed`);
  }, 120_000);

  it('retries the write that ends a run it refuses while the table is held, then ends it', async () => {
    await recoverUnderLock(
      { [`${LATEST}/inside-wait-fan-out`]: 'held-write' },
      { url: databaseUrl, statement: 'LOCK TABLE runtime_runs IN EXCLUSIVE MODE' },
      retried(`Couldn't end run ${MOCK_USER_ID}:held-write`),
    );
    expect(
      await eventually(
        () => runOf('held-write'),
        (row) => row?.status === 'error',
        'held-write ended',
      ),
    ).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
    await endedUnresumed('held-write');
  }, 120_000);

  it('ends each step a refused run had under way in a stop of its own, which a later reap leaves as it is', async () => {
    // Under way for longer than RUN_MAX_DURATION_SECONDS, past which the reaper ends a step an ended run left behind.
    const age = (runId: string): Promise<unknown> =>
      db.query(
        `UPDATE runtime_run_steps SET started_at = started_at - interval '2 hours' WHERE run_id = $1`,
        [`${MOCK_USER_ID}:${runId}`],
      );
    await reboot(async () => {
      await restoreGoldenHistory(db, dbos, `${LATEST}/parked-after-fan-out`, 'aged');
      await age('aged');
    });
    await eventually(
      () => runOf('aged'),
      (row) => row?.status === 'error',
      'aged ended',
    );
    await eventually(
      () => stopped('aged'),
      (rows) => rows.length > 0,
      "aged's steps stopped",
    );
    // A run that ended leaving a step under way, which the next boot's reap does end: once it has, the reap passed over both.
    await reboot(async () => {
      await restoreGoldenHistory(db, dbos, `${LATEST}/linear-parked`, 'left-behind');
      await db.query(
        `UPDATE runtime_runs SET status = 'error', error = 'Ended before the upgrade', finished_at = now(),
                waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL
          WHERE id = $1`,
        [`${MOCK_USER_ID}:left-behind`],
      );
      await age('left-behind');
    });
    await eventually(
      () => stepsWhere('left-behind', `status = 'error'`),
      (rows) => rows.length > 0,
      'the boot reap ending the step left behind',
    );
    await endedUnresumed('aged');
  }, 120_000);

  it('claims a decision for a run another build started and still runs, and refuses one nothing will resume', async () => {
    const workflows: Record<string, { name?: string; status?: string; executor?: string }> = {
      'later-build': { name: 'orchestr.runPlan.later' },
      'other-executor': { executor: 'elsewhere' },
      'later-build-ended': { name: 'orchestr.runPlan.later', status: 'ERROR' },
    };
    await startParked('v2-elsewhere');
    await reboot(async () => {
      await dbos.query(
        `UPDATE dbos.workflow_status SET executor_id = 'elsewhere' WHERE workflow_uuid = $1 AND name = $2`,
        [`${MOCK_USER_ID}:v2-elsewhere`, RUN_PLAN_V2_WORKFLOW],
      );
      for (const [runId, as] of Object.entries(workflows)) {
        await restoreGoldenHistory(db, dbos, `${LATEST}/linear-parked`, runId);
        await dbos.query(
          `UPDATE dbos.workflow_status
              SET name = COALESCE($2, name), status = COALESCE($3, status), executor_id = COALESCE($4, executor_id)
            WHERE workflow_uuid = $1`,
          [`${MOCK_USER_ID}:${runId}`, as.name ?? null, as.status ?? null, as.executor ?? null],
        );
      }
    });
    // Another build's to resume, as a run a later version started is on a rollback: the decision is claimed for it.
    expect((await decide('later-build', 'approve')).status).toBe(200);
    expect(await runOf('later-build')).toMatchObject({ status: 'waiting' });
    expect(await stepsWhere('later-build', 'claimed_by IS NOT NULL')).toHaveLength(1);
    for (const runId of ['other-executor', 'v2-elsewhere', 'later-build-ended']) {
      const refused = await decide(runId, 'approve');
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { detail: string }).detail).toBe(
        `Run ${runId} has stopped, so a decision can no longer reach it — run it again`,
      );
      expect(await stepsWhere(runId, 'claimed_at IS NOT NULL')).toEqual([]);
    }
  }, 120_000);

  it('takes the decision for a healthy run parked on the sequenced engine', async () => {
    await startParked('healthy-v2');
    expect((await decide('healthy-v2', 'approve')).status).toBe(200);
    expect(
      await eventually(
        () => runOf('healthy-v2'),
        (row) => row?.status === 'completed',
        'healthy-v2 done',
      ),
    ).toEqual({ status: 'completed', error: null });
  }, 120_000);

  it('refuses a decision for a run whose workflow ended while its row still waits, as when its recovery gave up', async () => {
    await reboot(async () => {
      await restoreGoldenHistory(db, dbos, `${LATEST}/linear-parked`, 'gave-up');
      await dbos.query(`UPDATE dbos.workflow_status SET status = 'ERROR' WHERE workflow_uuid = $1`, [
        `${MOCK_USER_ID}:gave-up`,
      ]);
    });
    const refused = await decide('gave-up', 'approve');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toBe(
      'Run gave-up has stopped, so a decision can no longer reach it — run it again',
    );
    expect(await runOf('gave-up')).toMatchObject({ status: 'waiting' });
    expect(await stepsWhere('gave-up', 'claimed_at IS NOT NULL')).toEqual([]);
  }, 120_000);

  it('writes nothing over a run that ended while it waited to end it, and stops it as it ended', async () => {
    await service?.crash();
    service = undefined;
    await restoreGoldenHistory(db, dbos, `${LATEST}/parked-after-fan-out`, 'ended-meanwhile');
    const scoped = `${MOCK_USER_ID}:ended-meanwhile`;
    await db.query(
      `UPDATE runtime_run_steps SET claimed_by = $2, claimed_at = now(), claimed_payload = '{"d":1}'
        WHERE run_id = $1 AND step_key = 'approve'`,
      [scoped, MOCK_USER_ID],
    );
    const holder = new Client({ connectionString: databaseUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE runtime_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [
        scoped,
      ]);
      const started = await startService({ service: THIS_SERVICE, databaseUrl });
      service = started;
      // The cancel commits while the guard waits on the run's row to end it.
      await eventually(
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE 'SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE%'`,
            )
          ).rows.length,
        (waiting) => waiting > 0,
        'the guard waiting on the run row',
      );
      await holder.query('COMMIT');
      await started.answered;
    } finally {
      await holder.end();
    }
    expect(
      await eventually(
        () => workflowOf('ended-meanwhile'),
        (status) => status !== 'PENDING',
        "ended-meanwhile's workflow",
      ),
    ).toBe('ERROR');
    const [stopped] = (
      await dbos.query<{ error: string }>(`SELECT error FROM dbos.workflow_status WHERE workflow_uuid = $1`, [
        scoped,
      ])
    ).rows;
    expect(stopped!.error).toContain('RunCancelledError');
    expect(await runOf('ended-meanwhile')).toEqual({ status: 'cancelled', error: null });
    expect(await stepsWhere('ended-meanwhile', 'claimed_at IS NOT NULL AND decided_by IS NULL')).toHaveLength(
      1,
    );
  }, 120_000);

  it('never judges a run this version started: caught inside its fan-out, it resumes and finishes', async () => {
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
      () => parkedSteps('live'),
      (rows) => rows.length === 1,
      'live parked',
    );

    await reboot();
    await eventually(
      () => parkedSteps('live'),
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

    await reboot(() => {
      slowAnswers = true;
      return Promise.resolve();
    });
    expect(
      await eventually(
        () => runOf('live'),
        (row) => row?.status === 'completed',
        'live done',
      ),
    ).toEqual({ status: 'completed', error: null });
    // The recorded step never runs again; the one in flight at the crash does, as any unrecorded step does.
    expect([hits.get('/slow'), hits.get('/fast')]).toEqual([2, 1]);
    expect(service!.log()).not.toContain(`Run ${MOCK_USER_ID}:live can't be resumed`);
  }, 120_000);
});
