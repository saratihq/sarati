import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M038 = readFileSync(join(__dirname, '..', 'db', 'migrations', '038_run_step_decider.sql'), 'utf8');

interface StepDecider {
  step_key: string;
  decided_by: string | null;
  decided_at: Date | null;
}

interface Step {
  key: string;
  kind?: string;
  /** `HH:MM` or `HH:MM:SS.mmm` on the test day; a step with no `finished` is still running. */
  started: string;
  finished?: string;
  output?: unknown;
  pinned?: boolean;
  decidedBy?: string;
  decidedAt?: string;
}

interface Shape {
  name: string;
  steps: Step[];
  /** The one step 038 may credit, or null when the run has more than one wait that could have taken the decision. */
  credits: string | null;
}

const at = (time: string): Date => new Date(`2026-10-09T${time.length === 5 ? `${time}:00.000` : time}Z`);
const sleptUntil = { slept_until: '2026-10-09T08:10:00.000Z' };

/** Each run's real last decision is at 08:30; its slot carries that moment as some other clock read it. */
const SHAPES: Shape[] = [
  {
    name: 'single',
    steps: [{ key: 'approve', started: '08:00', finished: '08:30:00.004' }],
    credits: 'approve',
  },
  {
    name: 'single-then-action',
    steps: [
      { key: 'approve', started: '08:00', finished: '08:30:00.004' },
      { key: 'notify', kind: 'action', started: '08:30:00.005', finished: '08:30:01.505' },
    ],
    credits: 'approve',
  },
  {
    name: 'wait-then-approval',
    steps: [
      { key: 'sleep', kind: 'delay', started: '08:00', finished: '08:10', output: sleptUntil },
      { key: 'approve', started: '08:10', finished: '08:30:00.004' },
    ],
    credits: 'approve',
  },
  {
    name: 'timer-beside',
    steps: [
      { key: 'sleep', kind: 'delay', started: '08:00', finished: '08:40', output: sleptUntil },
      { key: 'approve', started: '08:00', finished: '08:30:00.004' },
    ],
    credits: 'approve',
  },
  {
    name: 'pinned-beside',
    steps: [
      { key: 'sample', pinned: true, started: '08:00', finished: '08:00' },
      { key: 'approve', started: '08:00', finished: '08:30:00.004' },
    ],
    credits: 'approve',
  },
  {
    name: 'chain-finished',
    steps: [
      { key: 'legal', started: '08:00', finished: '08:10' },
      { key: 'finance', started: '08:10', finished: '08:30:00.004' },
    ],
    credits: null,
  },
  {
    name: 'chain-parked',
    steps: [
      { key: 'legal', started: '08:00', finished: '08:30:00.004' },
      { key: 'finance', started: '08:30:00.005' },
    ],
    credits: null,
  },
  {
    name: 'chain-timed-out',
    steps: [
      { key: 'legal', started: '08:00', finished: '08:30:00.004' },
      { key: 'finance', started: '08:30:00.005', finished: '08:35' },
    ],
    credits: null,
  },
  {
    name: 'chain-action-between',
    steps: [
      { key: 'legal', started: '08:00', finished: '08:30:00.004' },
      { key: 'notify', kind: 'action', started: '08:30:00.005', finished: '08:30:01.505' },
      { key: 'finance', started: '08:30:01.506' },
    ],
    credits: null,
  },
  {
    name: 'parallel-sibling',
    steps: [
      { key: 'legal', started: '08:00', finished: '08:30:00.004' },
      { key: 'finance', started: '08:00' },
    ],
    credits: null,
  },
  {
    name: 'both-answered',
    steps: [
      { key: 'legal', started: '08:00', finished: '08:30:00.004' },
      { key: 'finance', started: '08:00', finished: '08:20' },
    ],
    credits: null,
  },
  {
    name: 'loop-rounds',
    steps: [
      { key: 'loop#0/approve', started: '08:00', finished: '08:10' },
      { key: 'loop#1/approve', started: '08:10', finished: '08:30:00.004' },
    ],
    credits: null,
  },
];

/** How far the slot's clock read from the database's when it stamped the decision, in seconds. */
const SKEWS = [-60, -30, -2, -1.2, -1, -0.5, 0, 0.5, 1, 1.2, 2, 30, 60];

/** 038 copies a run's decider slot onto the one wait that could have taken it, by no clock, and keeps the slot. Scratch DB only. */
describe('migration 038: a decision is copied onto the step it answered (scratch DB)', () => {
  let db: Client;
  const owner = randomUUID();
  const ada = randomUUID();
  const bo = randomUUID();
  const decidedAt = at('08:30');

  const run = async (id: string, decider: string | null, steps: Step[], when = decidedAt): Promise<void> => {
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, decided_by, decided_at)
       VALUES ($1, $1, $2, 'p', 'completed', $3, $4)`,
      [id, owner, decider, decider ? when : null],
    );
    for (const s of steps) {
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, output, pinned, started_at,
                                        finished_at, decided_by, decided_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, CAST($6 AS json), $7, $8, $9, $10, $11)`,
        [
          id,
          s.key,
          s.key.split('/').pop(),
          s.kind ?? 'waitForEvent',
          s.finished ? 'completed' : 'running',
          JSON.stringify(s.output ?? null),
          s.pinned ?? false,
          at(s.started),
          s.finished ? at(s.finished) : null,
          s.decidedBy ?? null,
          s.decidedAt ? at(s.decidedAt) : null,
        ],
      );
    }
  };
  const decidersOf = async (runId: string): Promise<StepDecider[]> =>
    (
      await db.query<StepDecider>(
        `SELECT step_key, decided_by, decided_at FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
        [runId],
      )
    ).rows;
  const slotOf = async (runId: string): Promise<unknown> =>
    (await db.query(`SELECT decided_by, decided_at FROM runtime_runs WHERE id = $1`, [runId])).rows[0];
  const credited = (key: string, by: string, when = decidedAt): StepDecider => ({
    step_key: key,
    decided_by: by,
    decided_at: when,
  });
  const none = (key: string): StepDecider => ({ step_key: key, decided_by: null, decided_at: null });
  const skewed = (seconds: number): Date => new Date(decidedAt.getTime() + seconds * 1000);

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query(
      `ALTER TABLE runtime_run_steps DROP COLUMN IF EXISTS decided_by, DROP COLUMN IF EXISTS decided_at`,
    );
    await db.query(M038);

    for (const shape of SHAPES) {
      for (const skew of SKEWS) await run(`${shape.name}@${skew}`, bo, shape.steps, skewed(skew));
    }
    await run('r-none', null, [{ key: 'approve', started: '08:00', finished: '08:31' }]);
    await run('r-placed', ada, [
      { key: 'legal', started: '08:00', finished: '08:31', decidedBy: ada, decidedAt: '08:30' },
      { key: 'finance', started: '08:00' },
    ]);
    await run('r-back-again', bo, [
      { key: 'legal', started: '08:00', finished: '08:20', decidedBy: ada, decidedAt: '08:20' },
      { key: 'finance', started: '08:00', finished: '08:31' },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db.end();
  });

  it('copies each decision only onto a run’s one wait that could have taken it, whatever its slot’s clock read, and keeps the slot', async () => {
    await db.query(M038);
    await db.query(M038);
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const shape of SHAPES) {
      for (const skew of SKEWS) {
        const id = `${shape.name}@${skew}`;
        actual[id] = { steps: await decidersOf(id), slot: await slotOf(id) };
        expected[id] = {
          steps: shape.steps
            .map((s) => s.key)
            .sort()
            .map((key) => (key === shape.credits ? credited(key, bo, skewed(skew)) : none(key))),
          slot: { decided_by: bo, decided_at: skewed(skew) },
        };
      }
    }
    expect(actual).toEqual(expected);
  });

  it('credits no step of a run nobody decided', async () => {
    expect(await decidersOf('r-none')).toEqual([none('approve')]);
  });

  it('never credits a decision a step already holds to another wait beside it', async () => {
    expect(await decidersOf('r-placed')).toEqual([none('finance'), credited('legal', ada)]);
  });

  it('copies a decision an older image wrote after this one credited a wait onto the one wait left to take it', async () => {
    expect(await decidersOf('r-back-again')).toEqual([
      credited('finance', bo),
      credited('legal', ada, at('08:20')),
    ]);
  });

  it('copies a decision an older image wrote on the next boot, never over one a step holds', async () => {
    await run('r-old-image', bo, [{ key: 'approve', started: '08:00', finished: '08:31' }]);
    await run('r-held', bo, [
      { key: 'approve', started: '08:00', finished: '08:31', decidedBy: ada, decidedAt: '08:20' },
    ]);
    await db.query(M038);
    expect(await decidersOf('r-old-image')).toEqual([credited('approve', bo)]);
    expect(await decidersOf('r-held')).toEqual([credited('approve', ada, at('08:20'))]);
    expect(await slotOf('r-held')).toEqual({ decided_by: bo, decided_at: decidedAt });
  });
});
