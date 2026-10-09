import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunRecorderService } from '../src/runtime/run-recorder.service';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const USER = '00000000-0000-0000-0000-000000000001';
const HOUR_MS = 60 * 60_000;

interface StepRow {
  status: string;
  started_at: Date;
  waiting_topic: string | null;
  waiting_since: Date | null;
  waiting_timeout_at: Date | null;
}

/** The recorder's wait writes against real Postgres: deadlines kept on replay and upgrade, and a lost unpark repaired. */
describe('run recorder waits (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let recorder: RunRecorderService;

  const step = async (runId: string, stepKey: string): Promise<StepRow> =>
    (
      await db.query<StepRow>(
        `SELECT status, started_at, waiting_topic, waiting_since, waiting_timeout_at
           FROM runtime_run_steps WHERE run_id = $1 AND step_key = $2`,
        [runId, stepKey],
      )
    ).rows[0]!;
  const run = async (runId: string): Promise<{ status: string; decided_by: string | null }> =>
    (
      await db.query<{ status: string; decided_by: string | null }>(
        `SELECT status, decided_by FROM runtime_runs WHERE id = $1`,
        [runId],
      )
    ).rows[0]!;
  const start = async (runId: string, stepKey: string, startedAgoMs = 0): Promise<void> => {
    await recorder.runStarted(runId, runId, USER, { id: 'p' });
    await recorder.stepStarted(runId, stepKey, stepKey, 'waitForEvent');
    await db.query(
      `UPDATE runtime_run_steps SET started_at = started_at - make_interval(secs => $3::double precision / 1000)
        WHERE run_id = $1 AND step_key = $2`,
      [runId, stepKey, startedAgoMs],
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'rec@e2e.local', 'Rec', now(), now())`,
      [USER],
    );
    process.env.PGBOSS_ENABLED = 'false';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    recorder = app.get(RunRecorderService);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('parks a wait due one window after its step started, and a replay keeps that deadline', async () => {
    await start('r-fresh', 'approve');
    const { started_at } = await step('r-fresh', 'approve');
    const due = await recorder.stepWaiting('r-fresh', 'approve', 'approval', HOUR_MS);
    expect(due).toEqual(new Date(started_at.getTime() + HOUR_MS));
    expect(await step('r-fresh', 'approve')).toMatchObject({
      waiting_topic: 'approval',
      waiting_since: started_at,
      waiting_timeout_at: due,
    });
    expect((await run('r-fresh')).status).toBe('waiting');

    await new Promise((r) => setTimeout(r, 20));
    expect(await recorder.stepWaiting('r-fresh', 'approve', 'approval', HOUR_MS)).toEqual(due);
    expect((await step('r-fresh', 'approve')).waiting_timeout_at).toEqual(due);
  });

  it('gives a wait no earlier version recorded the deadline its step started with, not a fresh window', async () => {
    await start('r-upgraded', 'second', 20 * 60_000);
    const { started_at } = await step('r-upgraded', 'second');
    const due = await recorder.stepWaiting('r-upgraded', 'second', 'approval', HOUR_MS);
    expect(due).toEqual(new Date(started_at.getTime() + HOUR_MS));
    expect(due!.getTime() - Date.now()).toBeLessThan(41 * 60_000);
  });

  it('never parks a finished step again, and still reports the deadline it had', async () => {
    await start('r-finished', 'pause');
    await recorder.stepWaiting('r-finished', 'pause', 'orchestr:timer:pause', 61_000);
    await recorder.stepResumed('r-finished', 'pause');
    await recorder.stepFinished('r-finished', 'pause', { slept_until: 'x' }, null);
    const { started_at } = await step('r-finished', 'pause');

    const due = await recorder.stepWaiting('r-finished', 'pause', 'orchestr:timer:pause', 61_000);
    expect(due).toEqual(new Date(started_at.getTime() + 61_000));
    expect(await step('r-finished', 'pause')).toMatchObject({ status: 'completed', waiting_topic: null });
    expect((await run('r-finished')).status).toBe('running');
  });

  it('never parks a wait again once it resumed, though its step has not finished, and keeps its deadline', async () => {
    await start('r-resumed', 'approve');
    const due = await recorder.stepWaiting('r-resumed', 'approve', 'approval', HOUR_MS);
    await recorder.stepResumed('r-resumed', 'approve', true);

    expect(await recorder.stepWaiting('r-resumed', 'approve', 'approval', HOUR_MS)).toEqual(due);
    expect(await step('r-resumed', 'approve')).toMatchObject({ status: 'running', waiting_topic: null });
    expect((await run('r-resumed')).status).toBe('running');
  });

  it('repairs a wait whose unpark was lost once its step finishes, so the run stops reading waiting', async () => {
    await start('r-lost', 'approve');
    await recorder.stepWaiting('r-lost', 'approve', 'approval', HOUR_MS);
    expect((await run('r-lost')).status).toBe('waiting');
    await recorder.stepFinished('r-lost', 'approve', { decision: 'approved' }, null);
    expect(await step('r-lost', 'approve')).toMatchObject({ status: 'completed', waiting_topic: null });
    expect((await run('r-lost')).status).toBe('running');
  });

  it('credits the claimed decider only when the run takes the event', async () => {
    for (const [runId, answered] of [
      ['r-taken', true],
      ['r-timed-out', false],
    ] as const) {
      await start(runId, 'approve');
      await recorder.stepWaiting(runId, 'approve', 'approval', HOUR_MS);
      await db.query(
        `UPDATE runtime_run_steps SET claimed_at = now(), claimed_by = $2, claimed_payload = '{"d":1}'
          WHERE run_id = $1`,
        [runId, USER],
      );
      await recorder.stepResumed(runId, 'approve', answered);
    }
    expect(await run('r-taken')).toEqual({ status: 'running', decided_by: USER });
    expect(await run('r-timed-out')).toEqual({ status: 'running', decided_by: null });
  });
});
