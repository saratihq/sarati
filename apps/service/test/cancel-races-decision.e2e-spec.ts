import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/** DBOS accepts a send to a cancelled workflow, so only the run's own record can refuse a decision that comes too late. */
describe('a cancel racing a decision (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  /** Start a run that parks on one approval; resolves once it is parked, holding the run's own pending answer. */
  const park = async (runId: string): Promise<{ answered: Promise<Response> }> => {
    const running = http()
      .post('/api/runs')
      .send({
        run_id: runId,
        plan: {
          id: `plan-${runId}`,
          nodes: [{ kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 600_000 }],
        },
      })
      .then((res) => res);
    for (let i = 0; i < 200; i++) {
      const res = await http().get('/api/runs/waiting').expect(200);
      if ((res.body.runs as Array<{ run_id: string }>).some((r) => r.run_id === runId))
        return { answered: running };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} never parked`);
  };

  const recorded = async (
    runId: string,
  ): Promise<{ status: string; decided_by: string | null; parked: number }> => {
    const res = await db.query<{ status: string; decided_by: string | null; parked: string }>(
      `SELECT r.status, r.decided_by,
              (SELECT count(*) FROM runtime_run_steps s WHERE s.run_id = r.id AND s.waiting_topic IS NOT NULL) AS parked
         FROM runtime_runs r WHERE r.run_id = $1`,
      [runId],
    );
    const row = res.rows[0]!;
    return { status: row.status, decided_by: row.decided_by, parked: Number(row.parked) };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it('refuses a decision that arrives once the engine has cancelled the run, and records no decider', async () => {
    const { answered } = await park('doomed');
    const dbos = app.get(DbosRuntime);
    const cancelInEngine = dbos.cancelWorkflow.bind(dbos);
    let late: Promise<Response> | undefined;
    jest.spyOn(dbos, 'cancelWorkflow').mockImplementationOnce(async (id: string) => {
      await cancelInEngine(id);
      late = http()
        .post('/api/runs/doomed/events')
        .send({ topic: 'approval', payload: { decision: 'approved' } })
        .then((res) => res);
      await Promise.race([late, new Promise((r) => setTimeout(r, 1_000))]);
    });

    const cancelled = await http().post('/api/runs/doomed/cancel').expect(200);
    expect(cancelled.body.status).toBe('cancelled');

    const answer = await late!;
    expect(answer.status).toBe(409);
    expect(answer.body.detail).toBe('Run doomed is no longer waiting on topic "approval"');
    expect(await recorded('doomed')).toEqual({ status: 'cancelled', decided_by: null, parked: 0 });
    expect((await answered).body).toMatchObject({ code: 'run_cancelled' });
  });

  it('keeps a decision taken before a cancel, even when the cancel beats its delivery', async () => {
    const { answered } = await park('overtaken');
    const dbos = app.get(DbosRuntime);
    const sendInEngine = dbos.sendEvent.bind(dbos);
    let cancel: Response | undefined;
    jest
      .spyOn(dbos, 'sendEvent')
      .mockImplementationOnce(async (runId: string, topic: string, payload: unknown, key?: string) => {
        cancel = await http().post('/api/runs/overtaken/cancel');
        await sendInEngine(runId, topic, payload, key);
      });

    await http()
      .post('/api/runs/overtaken/events')
      .send({ topic: 'approval', payload: { decision: 'approved' } })
      .expect(200);

    expect(cancel?.status).toBe(200);
    expect(cancel?.body.status).toBe('cancelled');
    expect(await recorded('overtaken')).toEqual({ status: 'cancelled', decided_by: MOCK_USER_ID, parked: 0 });
    expect((await answered).body).toMatchObject({ code: 'run_cancelled' });
  });

  it('gives the wait back, crediting nobody, when the decision never reaches it', async () => {
    const { answered } = await park('undelivered');
    jest.spyOn(app.get(DbosRuntime), 'sendEvent').mockRejectedValueOnce(new Error('engine unreachable'));

    await http()
      .post('/api/runs/undelivered/events')
      .send({ topic: 'approval', payload: { decision: 'approved' } })
      .expect(500);
    expect(await recorded('undelivered')).toEqual({ status: 'waiting', decided_by: null, parked: 1 });

    await http()
      .post('/api/runs/undelivered/events')
      .send({ topic: 'approval', payload: { decision: 'rejected' } })
      .expect(200);
    const done = await answered;
    expect(done.status).toBe(201);
    expect(done.body.outputs.approve).toEqual({ decision: 'rejected' });
    expect(await recorded('undelivered')).toEqual({
      status: 'completed',
      decided_by: MOCK_USER_ID,
      parked: 0,
    });
  });

  it('holds a wait whose claim never sent its event only for the lease, then lets a person answer it', async () => {
    const { answered } = await park('orphaned');
    const claim = (at: string) =>
      db.query(
        `UPDATE runtime_run_steps s SET claimed_at = ${at} FROM runtime_runs r
          WHERE r.id = s.run_id AND r.run_id = 'orphaned' AND s.waiting_topic IS NOT NULL`,
      );
    const listed = async (): Promise<boolean> =>
      ((await http().get('/api/runs/waiting').expect(200)).body.runs as Array<{ run_id: string }>).some(
        (r) => r.run_id === 'orphaned',
      );
    const decide = () =>
      http()
        .post('/api/runs/orphaned/events')
        .send({ topic: 'approval', payload: { decision: 'approved' } });

    await claim('now()');
    expect(await listed()).toBe(false);
    expect((await decide()).status).toBe(409);
    expect(await recorded('orphaned')).toMatchObject({ status: 'waiting', parked: 1 });

    await claim(`now() - interval '2 minutes'`);
    expect(await listed()).toBe(true);
    await decide().expect(200);
    const done = await answered;
    expect(done.status).toBe(201);
    expect(done.body.outputs.approve).toEqual({ decision: 'approved' });
  });

  it('lands a decision made before any cancel, and a cancel after it changes nothing', async () => {
    const { answered } = await park('decided');
    await http()
      .post('/api/runs/decided/events')
      .send({ topic: 'approval', payload: { decision: 'approved' } })
      .expect(200);
    const done = await answered;
    expect(done.status).toBe(201);
    expect(done.body.outputs.approve).toEqual({ decision: 'approved' });

    const after = await http().post('/api/runs/decided/cancel').expect(200);
    expect(after.body.status).toBe('completed');
    expect(await recorded('decided')).toMatchObject({ status: 'completed', parked: 0 });
    expect((await recorded('decided')).decided_by).not.toBeNull();
  });
});
