import type { INestApplication } from '@nestjs/common';
import type { Client } from 'pg';
import request from 'supertest';

import type { RunReaperService } from '../../src/runs/run-reaper.service';

const irNode = (id: string, node_type: string, parameters: Record<string, unknown>) => ({
  id,
  name: id,
  node_type,
  type_version: 1,
  parameters,
  position: { x: 0, y: 0 },
  metadata: {},
});
const approval = (id: string) => irNode(id, 'orchestr:wait_for_event', { topic: id, timeout_ms: 600_000 });
// Under a minute, a Wait sleeps in place: the run stays in flight through it.
const inPlaceWait = (id: string, seconds: number) =>
  irNode(id, 'orchestr:wait_for_duration', { amount: seconds / 60, unit: 'minutes' });

const workflow = (nodes: Array<ReturnType<typeof irNode>>, from: string, to: string) => ({
  version: '1.0',
  name: 'resumed run',
  description: '',
  nodes,
  edges: [
    {
      id: `${from}->${to}`,
      source_node_id: from,
      source_port: 0,
      target_node_id: to,
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

function probe(app: INestApplication, db: Client, runId: string) {
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const run = async (): Promise<{ id: string; status: string; error: string | null }> =>
    (await db.query(`SELECT id, status, error FROM runtime_runs WHERE run_id = $1`, [runId])).rows[0] ?? {};
  const steps = async (): Promise<Record<string, string>> => {
    const rows = await db.query(
      `SELECT s.node_id, s.status FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
        WHERE r.run_id = $1`,
      [runId],
    );
    return Object.fromEntries(
      rows.rows.map((r: { node_id: string; status: string }) => [r.node_id, r.status]),
    );
  };
  const until = async (done: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 25));
    if (!(await done())) throw new Error('condition never held');
  };
  const start = (ir: unknown) =>
    http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: ir, run_id: runId })
      .then((r) => r);
  const approve = (topic: string) =>
    http().post(`/api/runs/${runId}/events`).send({ topic, payload: {} }).expect(200);
  // Two hours ago, as if the run had sat parked for longer than the max.
  const backdate = async (): Promise<string> => {
    const { id } = await run();
    await db.query(`UPDATE runtime_runs SET started_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    await db.query(`UPDATE runtime_run_steps SET started_at = now() - interval '2 hours' WHERE run_id = $1`, [
      id,
    ]);
    return id;
  };
  return { run, steps, until, start, approve, backdate };
}

/** Parks a run past the max, approves it, sweeps with a resumed and a park-spanning step in flight, and expects it to finish untouched. */
export async function expectResumedRunFinishes(
  app: INestApplication,
  db: Client,
  reaper: RunReaperService,
  runId: string,
): Promise<void> {
  const p = probe(app, db, runId);
  const finished = p.start(
    workflow(
      [approval('approval'), inPlaceWait('after', 3), inPlaceWait('spanning', 9)],
      'approval',
      'after',
    ),
  );
  await p.until(async () => (await p.run()).status === 'waiting');
  await p.backdate();

  await p.approve('approval');
  await p.until(async () => (await p.steps()).after === 'running');

  await reaper.reapStale();
  expect(await p.run()).toMatchObject({ status: 'running', error: null });
  expect(await p.steps()).toMatchObject({ approval: 'completed', after: 'running', spanning: 'running' });

  expect((await finished).status).toBe(201);
  expect(await p.run()).toMatchObject({ status: 'completed', error: null });
  expect(await p.steps()).toEqual({ approval: 'completed', after: 'completed', spanning: 'completed' });
}

/** Parks two approvals past the max, answers one long ago, the other now, and expects the run's time in flight to count from the second. */
export async function expectLastWaitStartsTheClock(
  app: INestApplication,
  db: Client,
  reaper: RunReaperService,
  runId: string,
): Promise<void> {
  const p = probe(app, db, runId);
  const finished = p.start(
    workflow([approval('first'), approval('second'), inPlaceWait('after', 3)], 'second', 'after'),
  );
  await p.until(async () => {
    const s = await p.steps();
    return s.first === 'running' && s.second === 'running' && (await p.run()).status === 'waiting';
  });

  await p.approve('first');
  await p.until(async () => (await p.steps()).first === 'completed');
  expect((await p.run()).status).toBe('waiting');
  const id = await p.backdate();
  await db.query(
    `UPDATE runtime_run_steps SET resumed_at = now() - interval '2 hours' WHERE run_id = $1 AND node_id = 'first'`,
    [id],
  );
  await reaper.reapStale();
  expect((await p.run()).status).toBe('waiting');

  await p.approve('second');
  await p.until(async () => (await p.steps()).after === 'running');
  await reaper.reapStale();
  expect(await p.run()).toMatchObject({ status: 'running', error: null });

  expect((await finished).status).toBe(201);
  expect(await p.run()).toMatchObject({ status: 'completed', error: null });
}
