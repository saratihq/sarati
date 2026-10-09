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
// Under a minute, a Wait sleeps in place: the run stays in flight through it.
const inPlaceWait = (id: string, seconds: number) =>
  irNode(id, 'orchestr:wait_for_duration', { amount: seconds / 60, unit: 'minutes' });

const approvalIr = {
  version: '1.0',
  name: 'resumed run',
  description: '',
  nodes: [
    irNode('approval', 'orchestr:wait_for_event', { topic: 'approve', timeout_ms: 600_000 }),
    inPlaceWait('after', 3),
    inPlaceWait('spanning', 9),
  ],
  edges: [
    {
      id: 'approval->after',
      source_node_id: 'approval',
      source_port: 0,
      target_node_id: 'after',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
};

/** Parks a run past the max, approves it, sweeps with a resumed and a park-spanning step in flight, and expects it to finish untouched. */
export async function expectResumedRunFinishes(
  app: INestApplication,
  db: Client,
  reaper: RunReaperService,
  runId: string,
): Promise<void> {
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const finished = http()
    .post('/api/runs/from-ir')
    .send({ workflow_ir: approvalIr, run_id: runId })
    .then((r) => r);
  const runRow = async (): Promise<{ id: string; status: string; error: string | null }> =>
    (await db.query(`SELECT id, status, error FROM runtime_runs WHERE run_id = $1`, [runId])).rows[0] ?? {};
  const stepStatuses = async (): Promise<Record<string, string>> => {
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

  await until(async () => (await runRow()).status === 'waiting');
  const { id } = await runRow();
  await db.query(`UPDATE runtime_runs SET started_at = now() - interval '2 hours' WHERE id = $1`, [id]);
  await db.query(`UPDATE runtime_run_steps SET started_at = now() - interval '2 hours' WHERE run_id = $1`, [
    id,
  ]);

  await http().post(`/api/runs/${runId}/events`).send({ topic: 'approve', payload: {} }).expect(200);
  await until(async () => (await stepStatuses()).after === 'running');

  await reaper.reapStale();
  expect(await runRow()).toMatchObject({ status: 'running', error: null });
  expect(await stepStatuses()).toMatchObject({
    approval: 'completed',
    after: 'running',
    spanning: 'running',
  });

  expect((await finished).status).toBe(201);
  expect(await runRow()).toMatchObject({ status: 'completed', error: null });
  expect(await stepStatuses()).toEqual({ approval: 'completed', after: 'completed', spanning: 'completed' });
}
