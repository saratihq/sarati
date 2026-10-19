import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import type { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { RunsService } from '../src/runs/runs.service';
import { RunRecorderService } from '../src/runtime/run-recorder.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const ISSUER = 'https://idp.approval-deciders.local';

interface Decider {
  id: string;
  name: string | null;
  email: string | null;
}

interface Step {
  step_key: string;
  status: string;
  output?: unknown;
  waiting?: unknown;
  decided_by: Decider | null;
  decided_at: string | null;
}

/**
 * Holds the next resume a wait records until released: the moment a cancel or a sibling's failure can overtake it.
 * Given `failing`, that resume's transaction then fails as a lost connection would, and the resume logs it.
 */
function holdNextResume(
  recorder: RunRecorderService,
  failing?: EntityManager,
): { entered: Promise<void>; release: () => void; restore: () => void; failed: () => boolean } {
  const original = recorder.stepResumed.bind(recorder);
  let enter!: () => void;
  let release!: () => void;
  let failed = false;
  const entered = new Promise<void>((r) => (enter = r));
  const released = new Promise<void>((r) => (release = r));
  const spy = jest.spyOn(recorder, 'stepResumed').mockImplementationOnce(async (...args) => {
    enter();
    await released;
    if (!failing) return original(...args);
    const lost = jest.spyOn(failing, 'transaction').mockImplementationOnce(() => {
      failed = true;
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    });
    try {
      return await original(...args);
    } finally {
      lost.mockRestore();
    }
  });
  return { entered, release, restore: () => spy.mockRestore(), failed: () => failed };
}

/** Approvals on topics named after their node ids — unconnected roots park at once, chained ones in turn. */
function approvalsIr(ids: string[], chained: boolean): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'approvals',
    description: '',
    nodes: ids.map((id, i) => ({
      id,
      name: id,
      node_type: 'orchestr:wait_for_event',
      type_version: 1,
      parameters: { topic: id, timeout_ms: 10 * 60_000 },
      position: { x: 0, y: i * 120 },
      metadata: {},
    })),
    edges: chained
      ? ids.slice(1).map((id, i) => ({
          id: `e-${ids[i]}-${id}`,
          source_node_id: ids[i],
          source_port: 0,
          target_node_id: id,
          target_port: 0,
          port_type: 'main',
        }))
      : [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

describe.each([
  { rail: 'in process (DBOS off)', dbos: false },
  { rail: 'durably (DBOS on)', dbos: true },
])('who answered each wait, $rail (e2e, isolated DB, two session members)', ({ dbos }) => {
  let app: INestApplication;
  let db: Client;
  let jwks: Server;
  let sessionA = '';
  let sessionB = '';
  let workflowId = '';

  const userA = randomUUID();
  const userB = randomUUID();
  const orgId = randomUUID();
  const ada: Decider = { id: userA, name: 'Ada Owner', email: 'ada@deciders.local' };
  const bo: Decider = { id: userB, name: 'Bo Member', email: 'bo@deciders.local' };

  const http = () => request(app.getHttpServer());
  const as = (session: () => string) => (r: request.Test) =>
    r.set('Authorization', `Bearer ${session()}`).set('X-Org-Id', orgId);
  const asA = as(() => sessionA);
  const asB = as(() => sessionB);

  async function eventually<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never saw ${what}`);
  }

  /** The inbox entries for one run, as a member other than its owner sees them. */
  async function inboxFor(runId: string): Promise<Array<Record<string, unknown>>> {
    const res = await asB(http().get('/api/runs/waiting')).expect(200);
    return (res.body.runs as Array<Record<string, unknown>>).filter((r) => r.run_id === runId);
  }

  const start = (runId: string, ids: string[], chained: boolean): Promise<Response> =>
    asA(
      http()
        .post('/api/runs/from-ir')
        .send({ workflow_ir: approvalsIr(ids, chained), workflow_id: workflowId, run_id: runId }),
    ).then((r) => r);
  const ref = (runId: string): string => encodeURIComponent(`${userA}:${runId}`);
  const answer = (who: typeof asA, runId: string, topic: string, payload: unknown) =>
    who(
      http()
        .post(`/api/runs/${ref(runId)}/events`)
        .send({ topic, payload }),
    );
  const detailOf = async (runId: string): Promise<Record<string, unknown>> =>
    (await asA(http().get(`/api/runs/${ref(runId)}`)).expect(200)).body as Record<string, unknown>;
  const stepOf = (detail: Record<string, unknown>, key: string): Step =>
    (detail.steps as Step[]).find((s) => s.step_key === key)!;
  const cancel = (runId: string) => asA(http().post(`/api/runs/${ref(runId)}/cancel`));
  const isTerminal = (d: Record<string, unknown>): boolean =>
    ['completed', 'error', 'cancelled'].includes(d.status as string);
  const stepRowOf = async (runId: string, key: string): Promise<Record<string, unknown>> =>
    (
      await db.query(
        `SELECT status, error, claimed_by, waiting_topic FROM runtime_run_steps WHERE run_id = $1 AND step_key = $2`,
        [`${userA}:${runId}`, key],
      )
    ).rows[0] as Record<string, unknown>;
  const runSlotOf = async (runId: string): Promise<unknown> =>
    (await db.query(`SELECT decided_by, decided_at FROM runtime_runs WHERE id = $1`, [`${userA}:${runId}`]))
      .rows[0];

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'deciders-kid', alg: 'RS256', use: 'sig' };
    jwks = createServer((req, res) => {
      if (req.url === '/boom') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));

    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, clerk_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'oidc-ada', now(), now()), ($4, $5, $6, 'oidc-bo', now(), now())`,
      [ada.id, ada.email, ada.name, bo.id, bo.email, bo.name],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Deciders', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $1, $3, 'member', now())`,
      [orgId, userA, userB],
    );

    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;
    process.env.DBOS_ENABLED = String(dbos);
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    const sign = (subject: string): Promise<string> =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'deciders-kid' })
        .setIssuer(ISSUER)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('30m')
        .sign(privateKey);
    sessionA = await sign('oidc-ada');
    sessionB = await sign('oidc-bo');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const deployed = await asA(
      http()
        .post('/api/deploy')
        .send({ workflow_json: approvalsIr(['legal', 'finance'], false) }),
    ).expect(201);
    workflowId = deployed.body.workflow_id as string;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => jwks.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.OIDC_ISSUER = '';
    process.env.OIDC_JWKS_URL = '';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it('two approvals parked at once keep each member who answered one, on its own step', async () => {
    const run = start('side-by-side', ['legal', 'finance'], false);
    await eventually(
      () => inboxFor('side-by-side'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );

    await answer(asB, 'side-by-side', 'legal', { decision: 'approved' }).expect(200);
    const midway = await eventually(
      () => detailOf('side-by-side'),
      (d) => stepOf(d, 'legal').status === 'completed',
      'the run took the legal decision',
    );
    expect(stepOf(midway, 'legal')).toMatchObject({ decided_by: bo });
    expect(stepOf(midway, 'finance')).toMatchObject({
      status: 'running',
      decided_by: null,
      decided_at: null,
    });
    expect(midway.decided_by).toEqual(bo);

    const again = await answer(asA, 'side-by-side', 'legal', { decision: 'rejected' });
    expect(again.status).toBe(409);
    expect(stepOf(await detailOf('side-by-side'), 'legal')).toMatchObject({ decided_by: bo });

    await answer(asA, 'side-by-side', 'finance', { decision: 'rejected' }).expect(200);
    const done = await run;
    expect(done.status).toBe(201);
    expect(done.body.outputs).toEqual({ legal: { decision: 'approved' }, finance: { decision: 'rejected' } });

    const detail = await detailOf('side-by-side');
    const legal = stepOf(detail, 'legal');
    const finance = stepOf(detail, 'finance');
    expect(legal).toMatchObject({ status: 'completed', decided_by: bo });
    expect(finance).toMatchObject({ status: 'completed', decided_by: ada });
    expect(Date.parse(legal.decided_at!)).toBeLessThanOrEqual(Date.parse(finance.decided_at!));
    expect(detail.decided_by).toBeNull();
    expect(detail.decided_at).toBeNull();
    expect(await runSlotOf('side-by-side')).toEqual({
      decided_by: ada.id,
      decided_at: new Date(finance.decided_at!),
    });
  }, 30_000);

  it('two approvals one after the other keep each member who answered one, on its own step', async () => {
    const run = start('in-turn', ['legal', 'finance'], true);
    await eventually(
      () => inboxFor('in-turn'),
      (rows) => rows[0]?.topic === 'legal',
      'legal listed',
    );
    await answer(asB, 'in-turn', 'legal', { decision: 'approved' }).expect(200);
    await eventually(
      () => inboxFor('in-turn'),
      (rows) => rows[0]?.topic === 'finance',
      'finance listed',
    );
    await answer(asA, 'in-turn', 'finance', { decision: 'approved' }).expect(200);
    expect((await run).status).toBe(201);

    const detail = await detailOf('in-turn');
    expect(stepOf(detail, 'legal')).toMatchObject({ decided_by: bo });
    expect(stepOf(detail, 'finance')).toMatchObject({ decided_by: ada });
    expect(detail.decided_by).toBeNull();
    expect(await runSlotOf('in-turn')).toMatchObject({ decided_by: ada.id });
  }, 30_000);

  it('one member answering every approval is named on the run, at their latest answer', async () => {
    const run = start('same-hand', ['legal', 'finance'], true);
    for (const topic of ['legal', 'finance']) {
      await eventually(
        () => inboxFor('same-hand'),
        (rows) => rows[0]?.topic === topic,
        `${topic} listed`,
      );
      await answer(asB, 'same-hand', topic, { decision: 'approved' }).expect(200);
    }
    expect((await run).status).toBe(201);

    const detail = await detailOf('same-hand');
    const legal = stepOf(detail, 'legal');
    const finance = stepOf(detail, 'finance');
    expect([legal.decided_by, finance.decided_by]).toEqual([bo, bo]);
    expect(Date.parse(finance.decided_at!)).toBeGreaterThan(Date.parse(legal.decided_at!));
    expect(detail.decided_by).toEqual(bo);
    expect(detail.decided_at).toBe(finance.decided_at);
  }, 30_000);

  it('a run decided before steps kept their own deciders names its last decider on the run', async () => {
    const old = `${userA}:decided-before`;
    const decidedAt = new Date(Date.now() - 3_600_000);
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, finished_at, workflow_id, org_id,
                                 decided_by, decided_at)
       VALUES ($1, 'decided-before', $2, 'p', 'completed', $3::timestamptz - interval '5 minutes', now(), $4, $5, $6, $3)`,
      [old, userA, decidedAt, workflowId, orgId, userB],
    );
    for (const key of ['legal', 'finance']) {
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at)
         VALUES (gen_random_uuid(), $1, $2, $2, 'waitForEvent', 'completed', $3::timestamptz - interval '5 minutes',
                 $3::timestamptz + interval '1 minute')`,
        [old, key, decidedAt],
      );
    }

    const detail = await detailOf('decided-before');
    expect(detail.decided_by).toEqual(bo);
    expect(detail.decided_at).toBe(decidedAt.toISOString());
    expect(detail.unattributed_decision).toEqual({ decided_by: bo, decided_at: decidedAt.toISOString() });
    expect([stepOf(detail, 'legal').decided_by, stepOf(detail, 'finance').decided_by]).toEqual([null, null]);
  });

  it('once a wait is answered after the upgrade, a run whose earlier decision has no step names only what its steps record', async () => {
    const run = start('upgraded', ['legal', 'finance'], false);
    await eventually(
      () => inboxFor('upgraded'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );
    await answer(asB, 'upgraded', 'legal', { decision: 'approved' }).expect(200);
    await eventually(
      () => detailOf('upgraded'),
      (d) => stepOf(d, 'legal').status === 'completed',
      'the run took the legal decision',
    );
    await db.query(
      `UPDATE runtime_run_steps SET decided_by = NULL, decided_at = NULL WHERE run_id = $1 AND step_key = 'legal'`,
      [`${userA}:upgraded`],
    );
    const before = await detailOf('upgraded');
    expect(before.decided_by).toEqual(bo);
    expect(before.unattributed_decision).toMatchObject({ decided_by: bo });

    await answer(asA, 'upgraded', 'finance', { decision: 'approved' }).expect(200);
    expect((await run).status).toBe(201);
    const detail = await detailOf('upgraded');
    expect(stepOf(detail, 'legal').decided_by).toBeNull();
    expect(stepOf(detail, 'finance').decided_by).toEqual(ada);
    expect(detail.decided_by).toEqual(ada);
    expect(detail.unattributed_decision).toBeNull();
    expect(await runSlotOf('upgraded')).toMatchObject({ decided_by: ada.id });
  }, 30_000);

  it('a decision made on an older version after this one credited a step is still named, on the run', async () => {
    const run = start('back-again', ['legal', 'finance'], false);
    await eventually(
      () => inboxFor('back-again'),
      (rows) => rows.length === 2,
      'both approvals listed',
    );
    await answer(asB, 'back-again', 'legal', { decision: 'approved' }).expect(200);
    await answer(asA, 'back-again', 'finance', { decision: 'approved' }).expect(200);
    expect((await run).status).toBe(201);
    await db.query(
      `UPDATE runtime_run_steps SET decided_by = NULL, decided_at = NULL WHERE run_id = $1 AND step_key = 'finance'`,
      [`${userA}:back-again`],
    );

    const detail = await detailOf('back-again');
    expect(stepOf(detail, 'legal').decided_by).toEqual(bo);
    expect(stepOf(detail, 'finance').decided_by).toBeNull();
    expect(detail.unattributed_decision).toMatchObject({ decided_by: ada });
    expect(detail.decided_by).toBeNull();
  }, 30_000);

  it('a run with one approval reports its decider on the run too, as it always has', async () => {
    const run = start('single', ['legal'], false);
    await eventually(
      () => inboxFor('single'),
      (rows) => rows.length === 1,
      'the approval listed',
    );

    const elsewhere = await answer(asB, 'single', 'finance', {});
    expect(elsewhere.status).toBe(409);
    expect(stepOf(await detailOf('single'), 'legal')).toMatchObject({ decided_by: null, decided_at: null });

    await answer(asB, 'single', 'legal', { decision: 'approved' }).expect(200);
    expect((await run).status).toBe(201);
    const detail = await detailOf('single');
    const legal = stepOf(detail, 'legal');
    expect(legal.decided_by).toEqual(bo);
    expect(detail.decided_by).toEqual(bo);
    expect(detail.decided_at).toBe(legal.decided_at);
  }, 30_000);

  it('names a decider whose account is gone by id, never as nobody', async () => {
    const gone = randomUUID();
    await db.query(`UPDATE runtime_run_steps SET decided_by = $2 WHERE run_id = $1 AND step_key = 'legal'`, [
      `${userA}:single`,
      gone,
    ]);
    await db.query(`UPDATE runtime_runs SET decided_by = $2 WHERE id = $1`, [`${userA}:single`, gone]);
    const detail = await detailOf('single');
    const missing: Decider = { id: gone, name: null, email: null };
    expect(stepOf(detail, 'legal').decided_by).toEqual(missing);
    expect(detail.decided_by).toEqual(missing);
  });

  it('an event that never reaches its wait credits nobody, and leaves the wait open for the next answer', async () => {
    const lost = `${userA}:lost`;
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, workflow_id, org_id)
       VALUES ($1, 'lost', $2, 'p', 'waiting', now(), $3, $4)`,
      [lost, userA, workflowId, orgId],
    );
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at,
                                      waiting_topic, waiting_since, waiting_timeout_at)
       VALUES (gen_random_uuid(), $1, 'legal', 'legal', 'waitForEvent', 'running', now(),
               'legal', now(), now() + interval '5 minutes')`,
      [lost],
    );

    const sent = await answer(asB, 'lost', 'legal', { decision: 'approved' });
    expect(sent.status).toBe(409);
    expect(sent.body.detail).toBe(
      `Run ${lost} is no longer waiting (the run did not survive a restart; re-run the workflow)`,
    );

    const step = await db.query(
      `SELECT decided_by, decided_at, claimed_by, waiting_topic FROM runtime_run_steps WHERE run_id = $1`,
      [lost],
    );
    expect(step.rows).toEqual([
      { decided_by: null, decided_at: null, claimed_by: null, waiting_topic: 'legal' },
    ]);
    expect(await inboxFor('lost')).toHaveLength(1);
  });

  it('a decision the run took keeps who made it when a cancel lands before the run records it', async () => {
    const resume = holdNextResume(app.get(RunRecorderService));
    try {
      const run = start('took-then-cancelled', ['legal'], false);
      await eventually(
        () => inboxFor('took-then-cancelled'),
        (rows) => rows.length === 1,
        'the approval listed',
      );
      await answer(asB, 'took-then-cancelled', 'legal', { decision: 'approved' }).expect(200);
      await resume.entered;
      await cancel('took-then-cancelled').expect(200);
      resume.release();
      const res = await run;
      expect([res.status, res.body.code]).toEqual([409, 'run_cancelled']);

      const detail = await eventually(
        () => detailOf('took-then-cancelled'),
        (d) => stepOf(d, 'legal').status === 'completed',
        'the run recording the decision it took',
      );
      expect(detail.status).toBe('cancelled');
      expect(stepOf(detail, 'legal').decided_by).toEqual(bo);
      expect(detail.decided_by).toEqual(bo);
      expect(await stepRowOf('took-then-cancelled', 'legal')).toMatchObject({ claimed_by: null });
    } finally {
      resume.restore();
    }
  }, 30_000);

  it('a run a sibling branch fails ends only after a decision its wait took is recorded, keeping who made it', async () => {
    const boom = {
      id: 'boom',
      name: 'boom',
      node_type: 'http.send_request',
      type_version: 1,
      parameters: {
        method: 'POST',
        url: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/boom`,
        body: {},
      },
      position: { x: 0, y: 240 },
      metadata: {},
    };
    const base = approvalsIr(['legal', 'finance'], false) as { nodes: unknown[]; edges: unknown[] };
    const workflowIr = {
      ...base,
      nodes: [...base.nodes, boom],
      edges: [
        {
          id: 'e-finance-boom',
          source_node_id: 'finance',
          source_port: 0,
          target_node_id: 'boom',
          target_port: 0,
          port_type: 'main',
        },
      ],
    };
    const resume = holdNextResume(app.get(RunRecorderService));
    try {
      const run = asA(
        http()
          .post('/api/runs/from-ir')
          .send({ workflow_ir: workflowIr, workflow_id: workflowId, run_id: 'sibling-fails' }),
      ).then((r) => r);
      await eventually(
        () => inboxFor('sibling-fails'),
        (rows) => rows.length === 2,
        'both approvals listed',
      );
      await answer(asB, 'sibling-fails', 'legal', { decision: 'approved' }).expect(200);
      await resume.entered;
      await answer(asA, 'sibling-fails', 'finance', { decision: 'approved' }).expect(200);
      await eventually(
        () => detailOf('sibling-fails'),
        (d) => stepOf(d, 'boom')?.status === 'error',
        'the sibling branch failing',
      );
      let endedFirst = false;
      for (let i = 0; i < 30 && !endedFirst; i++) {
        endedFirst = isTerminal(await detailOf('sibling-fails'));
        if (!endedFirst) await new Promise((r) => setTimeout(r, 50));
      }
      expect(endedFirst).toBe(false);
      resume.release();
      const res = await run;
      expect([res.status, res.body.failed_node_id]).toEqual([422, 'boom']);

      const detail = await detailOf('sibling-fails');
      expect(detail.status).toBe('error');
      expect(stepOf(detail, 'legal')).toMatchObject({ status: 'completed', decided_by: bo });
      expect(stepOf(detail, 'finance')).toMatchObject({ status: 'completed', decided_by: ada });
    } finally {
      resume.restore();
    }
  }, 30_000);

  it('a claim a cancel leaves for a resume that never comes is shown and acted on by nothing, and is dropped once its run is long over', async () => {
    const resume = holdNextResume(app.get(RunRecorderService));
    let run: Promise<Response> | undefined;
    try {
      run = start('resume-never-came', ['legal'], false);
      await eventually(
        () => inboxFor('resume-never-came'),
        (rows) => rows.length === 1,
        'the approval listed',
      );
      await answer(asB, 'resume-never-came', 'legal', { decision: 'approved' }).expect(200);
      await resume.entered;
      await cancel('resume-never-came').expect(200);
      expect(await stepRowOf('resume-never-came', 'legal')).toEqual({
        status: 'running',
        error: null,
        claimed_by: bo.id,
        waiting_topic: null,
      });

      const detail = await detailOf('resume-never-came');
      expect({
        status: detail.status,
        waiting: detail.waiting,
        decided_by: detail.decided_by,
        unattributed: detail.unattributed_decision,
        step: [stepOf(detail, 'legal').waiting, stepOf(detail, 'legal').decided_by],
      }).toEqual({
        status: 'cancelled',
        waiting: null,
        decided_by: null,
        unattributed: null,
        step: [null, null],
      });
      expect(await inboxFor('resume-never-came')).toEqual([]);
      const again = await answer(asA, 'resume-never-came', 'legal', { decision: 'rejected' });
      expect(again.status).toBe(409);
      expect(await app.get(RunsService).resendClaims(0)).toBe(0);
      const reaped = await app.get(RunReaperService).reapStale();
      expect([reaped.crashedRuns, reaped.timedOutWaits, reaped.strandedDecisions]).toEqual([0, 0, 0]);
      expect(await stepRowOf('resume-never-came', 'legal')).toMatchObject({
        status: 'running',
        claimed_by: bo.id,
      });
      expect((await detailOf('resume-never-came')).status).toBe('cancelled');

      await db.query(`UPDATE runtime_runs SET finished_at = now() - interval '2 hours' WHERE id = $1`, [
        `${userA}:resume-never-came`,
      ]);
      await app.get(RunReaperService).reapStale();
      expect(await stepRowOf('resume-never-came', 'legal')).toMatchObject({
        status: 'running',
        claimed_by: null,
      });
      expect((await detailOf('resume-never-came')).status).toBe('cancelled');
    } finally {
      resume.release();
      await run;
      resume.restore();
    }
  }, 30_000);

  it('a decision recorded after a later one never replaces it on the run, for an older image', async () => {
    const resume = holdNextResume(app.get(RunRecorderService));
    try {
      const run = start('recorded-late', ['legal', 'finance'], false);
      await eventually(
        () => inboxFor('recorded-late'),
        (rows) => rows.length === 2,
        'both approvals listed',
      );
      await answer(asA, 'recorded-late', 'legal', { decision: 'approved' }).expect(200);
      await resume.entered;
      await answer(asB, 'recorded-late', 'finance', { decision: 'approved' }).expect(200);
      const finance = stepOf(
        await eventually(
          () => detailOf('recorded-late'),
          (d) => stepOf(d, 'finance').status === 'completed',
          'the run taking the finance decision',
        ),
        'finance',
      );
      resume.release();
      expect((await run).status).toBe(201);

      const detail = await detailOf('recorded-late');
      const legal = stepOf(detail, 'legal');
      expect([legal.decided_by, stepOf(detail, 'finance').decided_by]).toEqual([ada, bo]);
      expect(Date.parse(legal.decided_at!)).toBeLessThan(Date.parse(finance.decided_at!));
      expect(await runSlotOf('recorded-late')).toEqual({
        decided_by: bo.id,
        decided_at: new Date(finance.decided_at!),
      });
    } finally {
      resume.restore();
    }
  }, 30_000);

  it.each([
    ['as the run took it', false],
    ['after a cancel ended its wait', true],
  ])(
    'a decision whose resume failed to record is credited when its step finishes, %s',
    async (_when, cancelled) => {
      const runId = cancelled ? 'lost-resume-cancelled' : 'lost-resume';
      const manager = app.get<DataSource>(getDataSourceToken()).manager;
      const resume = holdNextResume(app.get(RunRecorderService), manager);
      try {
        if (!cancelled) resume.release();
        const run = start(runId, ['legal'], false);
        await eventually(
          () => inboxFor(runId),
          (rows) => rows.length === 1,
          'the approval listed',
        );
        await answer(asB, runId, 'legal', { decision: 'approved' }).expect(200);
        await resume.entered;
        if (cancelled) {
          await cancel(runId).expect(200);
          resume.release();
        }
        const res = await run;
        expect(res.status).toBe(cancelled ? 409 : 201);
        expect(resume.failed()).toBe(true);

        const detail = await eventually(
          () => detailOf(runId),
          (d) => stepOf(d, 'legal').status === 'completed',
          'the run finishing the legal step',
        );
        expect(detail.status).toBe(cancelled ? 'cancelled' : 'completed');
        expect(stepOf(detail, 'legal').decided_by).toEqual(bo);
        expect(detail.decided_by).toEqual(bo);
        expect(await stepRowOf(runId, 'legal')).toMatchObject({ claimed_by: null, waiting_topic: null });
        if (!cancelled) expect(await runSlotOf(runId)).toMatchObject({ decided_by: bo.id });
      } finally {
        resume.restore();
      }
    },
    30_000,
  );
});
