import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from 'pg';

import { MAX_SUB_WORKFLOW_INVOCATIONS } from '../src/runtime/base-plan-interpreter';
import { ECHO_CHILD, ir, irEdge, irNode } from './support/golden-docs';
import { deploy } from './support/golden-outcome';
import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

const callable = irNode('trigger', 'orchestr:tool_trigger', {
  tool_name: 'work',
  description: 'Does some work',
  inputs: [{ name: 'q', type: 'string', description: 'input', required: false }],
});
const agent = (leafId: string, maxSteps: number, input: string) => [
  irNode('agent', 'orchestr:agent', {
    model: { provider: 'claude', model: 'claude-opus-4-8' },
    system_prompt: 'Call the tool every turn.',
    max_steps: maxSteps,
    input,
  }),
  irNode('leaf', 'orchestr:call_workflow', { workflow_id: leafId }),
];
// A workflow another can call, whose agent calls `leafId` as its tool on every one of `maxSteps` turns.
const caller = (leafId: string, maxSteps: number) =>
  ir(
    [callable, ...agent(leafId, maxSteps, '{{trigger.q}}')],
    [irEdge('trigger', 'agent'), irEdge('agent', 'leaf', 'tool')],
  );
// `children` sub-workflow steps side by side, each calling `callerId`.
const fanOut = (callerId: string, children: number) =>
  ir(
    Array.from({ length: children }, (_, k) =>
      irNode(`child${k}`, 'orchestr:call_workflow', { workflow_id: callerId, input: { q: `${k}` } }),
    ),
    [],
  );

/** The tree-wide sub-workflow cap: every agent call in a run tree, children's included, counts once against it (child processes, mock auth, scripted model). */
describe('the sub-workflow cap (e2e)', () => {
  const hits = new Map<string, number>();
  let holding = true;
  const fixture = createHttpServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    if (req.url === '/hold' && holding) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  async function stack(env: Record<string, string> = {}) {
    const databaseUrl = await createE2eDatabase(ADMIN_URL);
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const service = await bootService({ service: THIS_SERVICE, databaseUrl, model: 'tool-every-turn', env });
    return { databaseUrl, db, service };
  }

  const fromIr = (service: ServiceProcess, runId: string, doc: unknown, awaitMs: number): Promise<Response> =>
    fetch(`${service.base}/api/runs/from-ir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId, await_ms: awaitMs, workflow_ir: doc }),
    });

  const leafRuns = async (db: Client, leafId: string): Promise<number> =>
    Number(
      (
        await db.query<{ n: string }>(`SELECT count(*) AS n FROM runtime_runs WHERE workflow_id = $1`, [
          leafId,
        ])
      ).rows[0]!.n,
    );

  const ended = async (db: Client, runKey: string): Promise<{ status: string; error: string | null }> => {
    for (let i = 0; i < 1200; i++) {
      const run = await db.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM runtime_runs WHERE id = $1`,
        [runKey],
      );
      if (run.rows[0] && !['running', 'waiting'].includes(run.rows[0].status)) return run.rows[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${runKey} never ended`);
  };

  beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  });

  afterAll(async () => {
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
  });

  it.each([
    ['durable', 'the charges table', {}, MAX_SUB_WORKFLOW_INVOCATIONS],
    ['in process', 'memory', { DBOS_ENABLED: 'false' }, 0],
  ])(
    'caps a run tree at the budget however its calls fan out, %s, counting in %s, children included',
    async (_engine, _counter, env, charged) => {
      const { db, service } = await stack(env);
      try {
        const leafId = await deploy(service.base, ECHO_CHILD);
        for (const [children, turns] of [
          [3, 40],
          [4, 60],
        ] as const) {
          const callerId = await deploy(service.base, caller(leafId, turns));
          const before = await leafRuns(db, leafId);
          const runId = `fan-${children}x${turns}`;
          expect((await fromIr(service, runId, fanOut(callerId, children), 0)).ok).toBe(true);
          expect(await ended(db, `${MOCK_USER_ID}:${runId}`)).toEqual({ status: 'completed', error: null });
          expect((await leafRuns(db, leafId)) - before).toBe(MAX_SUB_WORKFLOW_INVOCATIONS);
          const allowed = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM runtime_sub_workflow_charges WHERE root_run_id = $1 AND allowed`,
            [`${MOCK_USER_ID}:${runId}`],
          );
          expect(allowed.rows[0]!.n).toBe(charged);
        }
      } finally {
        await service.crash();
        await db.end();
      }
    },
    300_000,
  );

  it('charges a call once though a crash between its charge and its step makes the step run again', async () => {
    const { databaseUrl, db, service } = await stack();
    let current = service;
    try {
      const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
      const leafId = await deploy(
        current.base,
        ir(
          [callable, irNode('hold', 'http.send_request', { method: 'GET', url: `${base}/hold` })],
          [irEdge('trigger', 'hold')],
        ),
      );
      const runKey = `${MOCK_USER_ID}:between`;
      const once = ir(agent(leafId, 1, 'go'), [irEdge('agent', 'leaf', 'tool')]);
      expect((await fromIr(current, 'between', once, 0)).ok).toBe(true);
      const charges = async (): Promise<Array<{ call_key: string; allowed: boolean }>> =>
        (
          await db.query<{ call_key: string; allowed: boolean }>(
            `SELECT call_key, allowed FROM runtime_sub_workflow_charges WHERE root_run_id = $1`,
            [runKey],
          )
        ).rows;
      for (let i = 0; i < 300 && !(hits.get('/hold') === 1 && (await charges()).length === 1); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const charged = await charges();
      expect(charged).toEqual([{ call_key: expect.any(String), allowed: true }]);

      await current.crash();
      holding = false;
      current = await bootService({ service: THIS_SERVICE, databaseUrl, model: 'tool-every-turn' });
      expect(await ended(db, runKey)).toEqual({ status: 'completed', error: null });
      expect(hits.get('/hold')).toBe(2);
      expect(await charges()).toEqual(charged);
    } finally {
      holding = true;
      await current.crash();
      await db.end();
    }
  }, 180_000);

  it.each([
    ['a called run', 1],
    ['a run its called run calls', 2],
  ])(
    "charges %s that runs again after a crash for its own calls alone, never again for the cut-off attempt's",
    async (_, depth) => {
      const { databaseUrl, db, service } = await stack();
      let current = service;
      try {
        const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
        let calleeId = await deploy(
          current.base,
          ir(
            [callable, irNode('hold', 'http.send_request', { method: 'GET', url: `${base}/hold` })],
            [irEdge('trigger', 'hold')],
          ),
        );
        for (let level = 0; level < depth; level++)
          calleeId = await deploy(current.base, caller(calleeId, 1));
        const runId = `nested-${depth}`;
        const runKey = `${MOCK_USER_ID}:${runId}`;
        const held = hits.get('/hold') ?? 0;
        // Each called run's agent makes its one call inside the root's step; the crash cuts the step off mid-call.
        expect((await fromIr(current, runId, fanOut(calleeId, 1), 0)).ok).toBe(true);
        const charges = async (): Promise<Array<{ call_key: string; allowed: boolean }>> =>
          (
            await db.query<{ call_key: string; allowed: boolean }>(
              `SELECT call_key, allowed FROM runtime_sub_workflow_charges WHERE root_run_id = $1`,
              [runKey],
            )
          ).rows;
        for (
          let i = 0;
          i < 300 && !(hits.get('/hold') === held + 1 && (await charges()).length === depth);
          i++
        ) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const cutOff = await charges();
        expect(cutOff).toEqual(
          Array.from({ length: depth }, () => ({ call_key: expect.any(String), allowed: true })),
        );

        await current.crash();
        holding = false;
        current = await bootService({ service: THIS_SERVICE, databaseUrl, model: 'tool-every-turn' });
        expect(await ended(db, runKey)).toEqual({ status: 'completed', error: null });
        // Every called run ran again whole, each agent asking for its call under a new id: those calls alone are charged.
        expect(hits.get('/hold')).toBe(held + 2);
        const charged = await charges();
        expect(charged).toEqual(
          Array.from({ length: depth }, () => ({ call_key: expect.any(String), allowed: true })),
        );
        const cutOffKeys = new Set(cutOff.map((charge) => charge.call_key));
        expect(charged.filter((charge) => cutOffKeys.has(charge.call_key))).toEqual([]);
      } finally {
        holding = true;
        await current.crash();
        await db.end();
      }
    },
    180_000,
  );
});
