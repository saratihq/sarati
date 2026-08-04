import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ConfigService } from '@nestjs/config';
import { Client } from 'pg';

import type { EnvConfig } from '../src/config/env.config';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import type { ManagedIntegrationProvider } from '../src/providers/managed-integration-provider';
import { SdkActionsProvider } from '../src/providers/sdk-actions.provider';
import { runPlanToDag } from '../src/compiler/run-plan-to-dag';
import type { RunAccess } from '../src/runs/run-access';
import { RunsService } from '../src/runs/runs.service';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import { RuntimeCompiler } from '../src/runtime/runtime-compiler';
import type { RunPlan } from '../src/runtime/run-plan';
import { withDatabase } from './support/test-db';

// A ManagedIntegrationProvider backed by the SDK http.send_request action (auth `none`, in-process).
const sdkConfig = {
  get: () => ({ composioApiKey: '', composioBaseUrl: '' }) as Partial<EnvConfig>,
} as unknown as ConfigService<{ env: EnvConfig }, true>;
function sdkProvider(): ManagedIntegrationProvider {
  const actions = new SdkActionsProvider(sdkConfig);
  return {
    key: 'sdk',
    runAction: (input) => actions.runAction(input),
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/** Re-invoking a run with the same id (DBOS crash recovery) must replay the checkpoint, not re-fire. */
describe('DBOS durable execution (Phase 1b)', () => {
  let server: Server;
  let baseUrl: string;
  let requestCount = 0;
  let sysDbName: string;
  const runtime = new DbosRuntime(new DagInterpreter(sdkProvider()));

  beforeAll(async () => {
    server = createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hit: requestCount }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Fresh, empty system database — DBOS builds its own checkpoint schema on launch.
    sysDbName = `orchestr_e2e_dbos_${randomBytes(4).toString('hex')}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${sysDbName} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${sysDbName}`);
    } finally {
      await admin.end();
    }

    DBOS.setConfig({ name: 'orchestr-e2e', systemDatabaseUrl: withDatabase(ADMIN_URL, sysDbName) });
    await DBOS.launch();
  }, 60_000);

  afterAll(async () => {
    await DBOS.shutdown();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${sysDbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  const plan = (): RunPlan => ({
    id: 'durable-plan',
    nodes: [
      {
        kind: 'action',
        id: 'call',
        actionId: 'http.send_request',
        props: { method: 'GET', url: `${baseUrl}/` },
      },
    ],
  });

  it('memoizes completed steps: a same-id replay does not re-fire the action', async () => {
    const runId = `run-${randomBytes(4).toString('hex')}`;
    const first = await runtime.runDurably(runPlanToDag(plan()), { externalUserId: 'u', runId });
    const replay = await runtime.runDurably(runPlanToDag(plan()), { externalUserId: 'u', runId }); // same id → recovery/replay

    expect(requestCount).toBe(1); // hit exactly once despite two runDurably calls
    expect(replay).toEqual(first); // replay returns the checkpointed result
    expect((first.outputs.call as { status: number }).status).toBe(200);
  }, 30_000);

  it('a distinct run id executes fresh', async () => {
    const before = requestCount;
    await runtime.runDurably(runPlanToDag(plan()), {
      externalUserId: 'u',
      runId: `run-${randomBytes(4).toString('hex')}`,
    });
    expect(requestCount).toBe(before + 1);
  }, 30_000);

  it('human-in-the-loop: a run suspends on waitForEvent until sendEvent resumes it (DBOS recv/send)', async () => {
    const runId = `hitl-${randomBytes(4).toString('hex')}`;
    const hitlPlan: RunPlan = {
      id: 'hitl-plan',
      nodes: [{ kind: 'waitForEvent', id: 'approval', topic: 'approve', timeoutMs: 20_000 }],
    };
    const runPromise = runtime.runDurably(runPlanToDag(hitlPlan), { externalUserId: 'u', runId });
    // Resume it — retry until the workflow exists in DBOS, then send exactly once.
    for (let i = 0; i < 50; i++) {
      try {
        await runtime.sendEvent(runId, 'approve', { decision: 'approved' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const result = await runPromise;
    expect(result.outputs.approval).toEqual({ decision: 'approved' });
  }, 30_000);

  it('async API: start (non-blocking) → poll running → sendEvent → poll completed with outputs', async () => {
    const runId = `async-${randomBytes(4).toString('hex')}`;
    const hitlPlan: RunPlan = {
      id: 'async-hitl',
      nodes: [{ kind: 'waitForEvent', id: 'approval', topic: 'approve', timeoutMs: 20_000 }],
    };
    // startDurably returns without waiting; the run parks on waitForEvent.
    await runtime.startDurably(runPlanToDag(hitlPlan), { externalUserId: 'u', runId });
    expect((await runtime.getRunStatus(runId)).status).toBe('running');

    await runtime.sendEvent(runId, 'approve', { decision: 'ok' });

    let final = await runtime.getRunStatus(runId);
    for (let i = 0; i < 50 && final.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      final = await runtime.getRunStatus(runId);
    }
    expect(final.status).toBe('completed');
    expect(final.outputs?.approval).toEqual({ decision: 'ok' });
  }, 30_000);

  it('getRunStatus: unknown run id → not_found', async () => {
    expect((await runtime.getRunStatus('does-not-exist')).status).toBe('not_found');
  }, 30_000);

  it('cancel (B7): a parked durable run → cancelWorkflow interrupts it → status is cancelled', async () => {
    const runId = `cancel-${randomBytes(4).toString('hex')}`;
    const hitlPlan: RunPlan = {
      id: 'cancel-hitl',
      nodes: [{ kind: 'waitForEvent', id: 'approval', topic: 'approve', timeoutMs: 20_000 }],
    };
    // Park the run on waitForEvent, then cancel it (no event is ever sent).
    await runtime.startDurably(runPlanToDag(hitlPlan), { externalUserId: 'u', runId });
    expect((await runtime.getRunStatus(runId)).status).toBe('running');

    await runtime.cancelWorkflow(runId);

    let s = await runtime.getRunStatus(runId);
    for (let i = 0; i < 50 && s.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = await runtime.getRunStatus(runId);
    }
    expect(s.status).toBe('cancelled'); // DBOS CANCELLED → our 'cancelled' mapping
  }, 30_000);

  it('RunsService scopes run ids per user: no cross-user read, resume, or idempotency collision', async () => {
    // dbosEnabled true (durable path) — this proof is about per-user run-id scoping.
    const config = {
      get: () => ({ dbosEnabled: true }),
    } as unknown as ConfigService<{ env: EnvConfig }, true>;
    const runs = new RunsService(new DagInterpreter(sdkProvider()), new RuntimeCompiler(), runtime, config);
    const runId = `scoped-${randomBytes(4).toString('hex')}`;

    const before = requestCount;
    await runs.run(plan(), { externalUserId: 'alice', runId });
    expect(requestCount).toBe(before + 1);

    // Alice can poll her run; the same id under Bob resolves NOTHING (no IDOR).
    const access = (userId: string): RunAccess => ({ userId, activeOrgId: null, orgWide: true });
    expect((await runs.getRun(runId, access('alice'))).status).toBe('completed');
    expect((await runs.getRun(runId, access('bob'))).status).toBe('not_found');

    // Bob reusing Alice's run_id executes FRESH — no cross-user idempotency collision.
    await runs.run(plan(), { externalUserId: 'bob', runId });
    expect(requestCount).toBe(before + 2);
  }, 30_000);
});
