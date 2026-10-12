import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import { ClaimResender } from '../src/runs/claim-resender';
import { RunsService } from '../src/runs/runs.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/** DBOS accepts a send to a cancelled workflow, so only the run's own record can refuse a decision that comes too late. */
describe('a cancel racing a decision (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let dbos: Client;

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
    const sysUrl = new URL(process.env.DATABASE_URL);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: sysUrl.toString() });
    await dbos.connect();
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    await dbos.end();
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
    expect(answer.body.detail).toBe('Run doomed is not waiting for an event');
    expect(await recorded('doomed')).toEqual({ status: 'cancelled', decided_by: null, parked: 0 });
    expect((await answered).body).toMatchObject({ code: 'run_cancelled' });
  });

  it('accepts a decision taken before a cancel, and credits nobody once the cancel stops the run taking it', async () => {
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
    expect((await answered).body).toMatchObject({ code: 'run_cancelled' });
    expect(await recorded('overtaken')).toEqual({ status: 'cancelled', decided_by: null, parked: 0 });
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

  it('sends a decision whose claim never went out again, and never hands its wait to anyone else', async () => {
    const { answered } = await park('orphaned');
    // A decision claimed and committed by a process that died before sending it.
    await db.query(
      `UPDATE runtime_run_steps s
          SET claimed_at = now() - interval '2 minutes', claimed_by = $1, claimed_payload = '{"decision":"first"}'
         FROM runtime_runs r
        WHERE r.id = s.run_id AND r.run_id = 'orphaned' AND s.waiting_topic IS NOT NULL`,
      [MOCK_USER_ID],
    );
    const listed = (
      (await http().get('/api/runs/waiting').expect(200)).body.runs as Array<{ run_id: string }>
    ).some((r) => r.run_id === 'orphaned');
    expect(listed).toBe(false);

    const second = await http()
      .post('/api/runs/orphaned/events')
      .send({ topic: 'approval', payload: { decision: 'second' } });
    expect(second.status).toBe(409);
    expect(second.body.detail).toBe('Every wait of run orphaned on topic "approval" is already decided');

    const done = await answered;
    expect(done.status).toBe(201);
    expect(done.body.outputs.approve).toEqual({ decision: 'first' });
    expect(await recorded('orphaned')).toEqual({ status: 'completed', decided_by: MOCK_USER_ID, parked: 0 });
  });

  it('sends a decision whose claim never went out again on its own timer, with no reaper running', async () => {
    const { answered } = await park('resent');
    await db.query(
      `UPDATE runtime_run_steps s
          SET claimed_at = now() - interval '2 minutes', claimed_by = $1, claimed_payload = '{"decision":"resent"}'
         FROM runtime_runs r
        WHERE r.id = s.run_id AND r.run_id = 'resent' AND s.waiting_topic IS NOT NULL`,
      [MOCK_USER_ID],
    );

    await app.get(ClaimResender).retry();

    const done = await answered;
    expect(done.body.outputs.approve).toEqual({ decision: 'resent' });
    expect(await recorded('resent')).toEqual({ status: 'completed', decided_by: MOCK_USER_ID, parked: 0 });
  });

  it('sends nothing for a decided wait within the margin of its deadline, on a further event or the timer', async () => {
    const running = http()
      .post('/api/runs')
      .send({
        run_id: 'closing',
        plan: {
          id: 'plan-closing',
          nodes: [{ kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 6_000 }],
        },
      })
      .then((res) => res);
    for (let i = 0; i < 100 && (await recorded('closing').catch(() => null))?.parked !== 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await db.query(
      `UPDATE runtime_run_steps s
          SET claimed_at = now() - interval '2 minutes', claimed_by = $1, claimed_payload = '{"decision":"late"}',
              waiting_timeout_at = now() + interval '1 second'
         FROM runtime_runs r
        WHERE r.id = s.run_id AND r.run_id = 'closing' AND s.waiting_topic IS NOT NULL`,
      [MOCK_USER_ID],
    );

    const again = await http()
      .post('/api/runs/closing/events')
      .send({ topic: 'approval', payload: { decision: 'x' } });
    expect(again.status).toBe(409);
    await app.get(ClaimResender).retry();
    expect(
      (
        await dbos.query(`SELECT 1 FROM dbos.notifications WHERE destination_uuid = $1`, [
          `${MOCK_USER_ID}:closing`,
        ])
      ).rows,
    ).toEqual([]);
    expect((await running).body.outputs).toEqual({ approve: null });
  }, 30_000);

  it('names a step that is not a wait, and lists only the waits still open to a decision', async () => {
    const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: id, timeoutMs: 600_000 });
    const running = http()
      .post('/api/runs')
      .send({
        run_id: 'mixed',
        plan: {
          id: 'plan-mixed',
          nodes: [
            { kind: 'code', id: 'prep', language: 'js', code: 'return 1;' },
            { kind: 'delay', id: 'short', ms: 10 },
            { kind: 'parallel', id: 'fork', branches: [[approval('legal')], [approval('finance')]] },
          ],
        },
      })
      .then((res) => res);
    for (let i = 0; i < 100 && (await recorded('mixed').catch(() => null))?.parked !== 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const timed = await http().post('/api/runs/mixed/events').send({ topic: 'legal', step_key: 'short' });
    expect(timed.body).toMatchObject({
      code: 'timer_wait',
      detail: 'Step "short" of run mixed is a timed wait; it can\'t be sent to',
    });
    const notAWait = await http().post('/api/runs/mixed/events').send({ topic: 'legal', step_key: 'prep' });
    expect(notAWait.body.detail).toBe(
      'Step "prep" of run mixed is not a wait — it waits at "fork|0/legal", "fork|1/finance"',
    );

    await db.query(
      `UPDATE runtime_run_steps s SET claimed_at = now(), claimed_by = $1, claimed_payload = '{"d":"legal"}'
         FROM runtime_runs r WHERE r.id = s.run_id AND r.run_id = 'mixed' AND s.step_key = 'fork|0/legal'`,
      [MOCK_USER_ID],
    );
    const elsewhere = await http().post('/api/runs/mixed/events').send({ topic: 'nope' });
    expect(elsewhere.body.detail).toBe('Run mixed is waiting on topic "finance", not "nope"');
    const typo = await http()
      .post('/api/runs/mixed/events')
      .send({ topic: 'finance', step_key: 'fork|1/fnance' });
    expect(typo.body.detail).toBe(
      'Run mixed has no wait at step "fork|1/fnance" — it waits at "fork|1/finance"',
    );

    await http().post('/api/runs/mixed/cancel').expect(200);
    await running;
  });

  it('counts only the decisions it actually sent again', async () => {
    const { answered } = await park('counted');
    await db.query(
      `UPDATE runtime_run_steps s
          SET claimed_at = now() - interval '2 minutes', claimed_by = $1, claimed_payload = '{"decision":"counted"}'
         FROM runtime_runs r
        WHERE r.id = s.run_id AND r.run_id = 'counted' AND s.waiting_topic IS NOT NULL`,
      [MOCK_USER_ID],
    );
    const runs = app.get(RunsService);
    jest.spyOn(app.get(DbosRuntime), 'sendEvent').mockRejectedValueOnce(new Error('system database down'));
    expect(await runs.resendClaims(0)).toBe(0);
    expect(await recorded('counted')).toMatchObject({ status: 'waiting', parked: 1 });

    expect(await runs.resendClaims(0)).toBe(1);
    expect((await answered).body.outputs.approve).toEqual({ decision: 'counted' });
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
