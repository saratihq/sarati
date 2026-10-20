import type { Client } from 'pg';

import { LANE_CHILD } from './golden-docs';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/** A decision sent once the wait it answers is parked: aimed at `step_key`, or sent by topic alone. */
interface Decision {
  topic: string;
  step_key?: string;
}

/** How a history is driven after it recovers: its decisions in order, then until it ends or until `parked` waits sit on `on`. */
export interface Drive {
  decisions: Decision[];
  until: 'ended' | { parked: number; on: string };
  /** A workflow the run calls after it recovers, which is deployed first and stands in for the one it recorded. */
  calls?: unknown;
}

/** The histories a legacy recovery resumes, and how each is driven; any other is one the recovery guard refuses. */
export const DRIVES: Readonly<Record<string, Drive>> = {
  'linear-parked': { decisions: [{ topic: 'approval', step_key: 'approve' }], until: 'ended' },
  'parked-before-fan-out': { decisions: [{ topic: 'approval', step_key: 'approve' }], until: 'ended' },
  'agent-tool-calls': { decisions: [{ topic: 'approval', step_key: 'approve' }], until: 'ended' },
  pins: { decisions: [{ topic: 'approval', step_key: 'approve' }], until: 'ended' },
  'parked-in-error-lane': { decisions: [{ topic: 'approval', step_key: 'approve' }], until: 'ended' },
  'after-call-workflow': { decisions: [{ topic: 'approval', step_key: 'approve' }], until: 'ended' },
  'parked-before-call-workflow': {
    decisions: [{ topic: 'approval', step_key: 'approve' }],
    until: 'ended',
    calls: LANE_CHILD,
  },
  'shared-receive-before-fan-out': { decisions: [{ topic: 'gate' }], until: { parked: 2, on: 'approval' } },
};

/** What a recovered run came to: its steps, its ops in order and its outputs, and those of the runs it called. */
export interface GoldenOutcome {
  status: string;
  error: string | null;
  outputs: unknown;
  steps: Array<Record<string, unknown>>;
  ops: string[];
  children: Array<{ parent_step_key: string; status: string; steps: Array<Record<string, unknown>> }>;
}

/** The id of the workflow a recorded history calls, which a restore swaps for one deployed where it runs. */
export function recordedCallee(raw: string): string | undefined {
  return /workflowId\\?"\s*:\s*\\?"([0-9a-f-]{36})/.exec(raw)?.[1];
}

/** Publish `doc` on the service at `base` so a run can call it, and answer its id. */
export async function deploy(base: string, doc: unknown): Promise<string> {
  const res = await fetch(`${base}/api/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow_json: doc }),
  });
  const body = (await res.json()) as { workflow_id?: string; is_live?: boolean };
  if (!res.ok || !body.workflow_id || body.is_live !== true) {
    throw new Error(`the called workflow did not go live: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.workflow_id;
}

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never saw ${what}`);
}

/** Drive the recovered run `runId` on the service at `base` as `drive` says, and answer what it came to. */
export async function driveGolden(
  base: string,
  db: Client,
  dbos: Client,
  runId: string,
  drive: Drive,
): Promise<GoldenOutcome> {
  const runKey = `${MOCK_USER_ID}:${runId}`;
  const parkedOn = async (topic: string): Promise<string[]> =>
    (
      await db.query<{ step_key: string }>(
        `SELECT step_key FROM runtime_run_steps
          WHERE run_id = $1 AND waiting_topic = $2 AND finished_at IS NULL ORDER BY step_key`,
        [runKey, topic],
      )
    ).rows.map((r) => r.step_key);
  for (const decision of drive.decisions) {
    await eventually(
      `${runId} parked on ${decision.topic}`,
      () => parkedOn(decision.topic),
      (keys) => (decision.step_key ? keys.includes(decision.step_key) : keys.length > 0),
    );
    const sent = await fetch(`${base}/api/runs/${runId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...decision, payload: { for: decision.step_key ?? decision.topic } }),
    });
    if (!sent.ok) throw new Error(`${runId}: ${decision.topic} was refused, ${sent.status}`);
  }
  const { until } = drive;
  if (until === 'ended') {
    await eventually(
      `${runId} ended`,
      () => db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE id = $1`, [runKey]),
      (res) => ['completed', 'error'].includes(res.rows[0]?.status ?? ''),
    );
  } else {
    await eventually(
      `${runId} parked ${until.parked} on ${until.on}`,
      () => parkedOn(until.on),
      (keys) => keys.length === until.parked,
    );
  }
  return outcomeOf(db, dbos, runKey);
}

const STEP = `step_key, kind, status, output, error, waiting_topic, delivery_topic,
  (decided_by = '${MOCK_USER_ID}') AS decided_by_user`;

async function outcomeOf(db: Client, dbos: Client, runKey: string): Promise<GoldenOutcome> {
  const run = await db.query<{ status: string; error: string | null; outputs: unknown }>(
    `SELECT status, error, outputs FROM runtime_runs WHERE id = $1`,
    [runKey],
  );
  const steps = await db.query(`SELECT ${STEP} FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`, [
    runKey,
  ]);
  const ops = await dbos.query<{ function_name: string }>(
    `SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
    [runKey],
  );
  const children = await db.query<{ id: string; parent_step_key: string; status: string }>(
    `SELECT id, parent_step_key, status FROM runtime_runs WHERE parent_run_id = $1 ORDER BY parent_step_key`,
    [runKey],
  );
  return {
    status: run.rows[0]!.status,
    error: run.rows[0]!.error,
    outputs: run.rows[0]!.outputs,
    steps: steps.rows,
    ops: ops.rows.map((r) => r.function_name),
    children: await Promise.all(
      children.rows.map(async (child) => ({
        parent_step_key: child.parent_step_key,
        status: child.status,
        steps: (
          await db.query(`SELECT ${STEP} FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`, [
            child.id,
          ])
        ).rows,
      })),
    ),
  };
}
