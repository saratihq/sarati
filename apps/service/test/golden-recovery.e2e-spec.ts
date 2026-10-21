import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { NOT_RESUMABLE } from '../src/dbos/recovery-guard';
import {
  GOLDEN_DIR,
  PREVIOUS_BUILD,
  goldenShapes,
  restoreGoldenHistory,
  type GoldenHistory,
} from './support/golden-history';
import { DRIVES, deploy, driveGolden, recordedCallee, type GoldenOutcome } from './support/golden-outcome';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const SHAPES = goldenShapes();
const RESUMED = SHAPES.filter((shape) => DRIVES[shape]);
const REFUSED = SHAPES.filter((shape) => !DRIVES[shape]);

const ATTACHED = ['attach-async', 'attach-sync'];

const raw = (shape: string): string =>
  readFileSync(join(GOLDEN_DIR, PREVIOUS_BUILD, `${shape}.json`), 'utf8');

// A legacy fan-out issues its ops in whatever order they come, which is what row 19 ends for runs on v2.
const FANS_OUT_AFTER_RECOVERY = new Set(['parked-before-fan-out', 'shared-receive-before-fan-out']);
const comparable = (shape: string, outcome: GoldenOutcome | undefined): unknown =>
  outcome && FANS_OUT_AFTER_RECOVERY.has(shape) ? { ...outcome, ops: [...outcome.ops].sort() } : outcome;

/** Constitution row 19's legacy clause: a run the legacy engine started resumes on this build as the build that recorded it did (child processes, DBOS on, mock auth). */
describe('legacy runs recovered on this build (e2e)', () => {
  let databaseUrl: string;
  let db: Client;
  let dbos: Client;
  let service: ServiceProcess | undefined;

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: sysUrl.toString() });
    await dbos.connect();
    // Served once, the mock user has the org every restore moves its run into.
    expect((await fetch(`${service.base}/api/runs/waiting`)).ok).toBe(true);
    const replace: Record<string, Record<string, string>> = {};
    for (const shape of RESUMED) {
      const { calls } = DRIVES[shape]!;
      const callee = recordedCallee(raw(shape));
      if (calls && callee) replace[shape] = { [callee]: await deploy(service.base, calls) };
    }
    await service.crash();
    for (const shape of SHAPES) {
      await restoreGoldenHistory(db, dbos, `${PREVIOUS_BUILD}/${shape}`, shape, replace[shape]);
    }
    for (const runId of ATTACHED) {
      await restoreGoldenHistory(db, dbos, `${PREVIOUS_BUILD}/linear-parked`, runId);
    }
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
  }, 120_000);

  afterAll(async () => {
    await service?.crash();
    await dbos?.end();
    await db?.end();
  }, 30_000);

  it.each(RESUMED)(
    'resumes %s as the build that recorded it did: its steps, ops, outputs and deciders',
    async (shape) => {
      const recorded = (JSON.parse(raw(shape)) as GoldenHistory).outcome;
      expect(recorded).toBeDefined();
      const outcome = await driveGolden(service!.base, db, dbos, shape, DRIVES[shape]!);
      expect(comparable(shape, outcome)).toEqual(comparable(shape, recorded));
    },
    60_000,
  );

  it('attaches a start that names a legacy run’s id to that run, whichever way it is started, rather than starting another', async () => {
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${service!.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const other = (runId: string) => ({
      run_id: runId,
      plan: { id: `plan-other-${runId}`, nodes: [{ kind: 'delay', id: 'other', ms: 1 }] },
    });
    const started = await post('/api/runs/async', other('attach-async'));
    expect(started.status).toBe(201);
    const waited = post('/api/runs', other('attach-sync'));
    for (const runId of ATTACHED) {
      await driveGolden(service!.base, db, dbos, runId, DRIVES['linear-parked']!);
    }
    const sync = await waited;
    expect(sync.status).toBe(201);
    expect(((await sync.json()) as { outputs: Record<string, unknown> }).outputs).toMatchObject({
      approve: { for: 'approve' },
    });
    const workflows = await dbos.query<{ name: string }>(
      `SELECT name FROM dbos.workflow_status WHERE workflow_uuid = ANY($1) ORDER BY workflow_uuid`,
      [ATTACHED.map((runId) => `${MOCK_USER_ID}:${runId}`)],
    );
    expect(workflows.rows).toEqual([{ name: 'orchestr.runPlan' }, { name: 'orchestr.runPlan' }]);
    const recorded = (JSON.parse(raw('linear-parked')) as GoldenHistory).outcome!;
    for (const runId of ATTACHED) {
      const steps = await db.query<{ step_key: string }>(
        `SELECT step_key FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
        [`${MOCK_USER_ID}:${runId}`],
      );
      expect(steps.rows.map((r) => r.step_key)).toEqual(recorded.steps.map((step) => step.step_key));
    }
  }, 60_000);

  it.each(REFUSED)(
    'ends %s, which ran steps side by side, in error instead of resuming it',
    async (shape) => {
      const runKey = `${MOCK_USER_ID}:${shape}`;
      for (let i = 0; i < 300; i++) {
        const run = await db.query<{ status: string; error: string | null }>(
          `SELECT status, error FROM runtime_runs WHERE id = $1`,
          [runKey],
        );
        if (run.rows[0]?.status === 'error') {
          expect(run.rows[0]).toEqual({ status: 'error', error: NOT_RESUMABLE['side-by-side'] });
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${shape} never ended`);
    },
    60_000,
  );
});
