import { randomUUID } from 'node:crypto';

import { Client, Pool, type PoolClient } from 'pg';

import { ADMIN_URL, createE2eDatabase } from '../../../service/test/support/test-db';
import { ThreadStore } from './thread-store';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The rekey against a real composer_threads table, raced by a workflow delete (constitution #11's lock order). */
describe('ThreadStore.rekey (e2e, throwaway Postgres database)', () => {
  let url: string;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    url = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: url });
    await db.connect();
    pool = new Pool({ connectionString: url });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(url).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const workflowWithThreads = async (): Promise<{ workflowId: string; scratch: string }> => {
    const workflowId = randomUUID();
    await db.query(`INSERT INTO workflows (id, name) VALUES ($1, 'rekeyed')`, [workflowId]);
    const scratch = await db.query<{ id: string }>(
      `INSERT INTO composer_threads (user_key, workflow_id) VALUES ('user_1', NULL), ('user_1', $1) RETURNING id`,
      [workflowId],
    );
    return { workflowId, scratch: scratch.rows[0]!.id };
  };

  const threadsOf = async (workflowId: string): Promise<string[]> =>
    (
      await db.query<{ id: string }>(`SELECT id FROM composer_threads WHERE workflow_id = $1`, [workflowId])
    ).rows.map((r) => r.id);

  const deadlocks = async (): Promise<number> =>
    Number(
      (
        await db.query<{ deadlocks: string }>(
          `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`,
        )
      ).rows[0]!.deadlocks,
    );

  const lockWaiter = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const waiting = await db.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (waiting.rows.length > 0) return;
      await pause(25);
    }
    throw new Error('never saw a lock waiter');
  };

  // The statements WorkflowLifecycleService.deleteWorkflow's final transaction runs.
  const deleteWorkflow = async (workflowId: string): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM workflows WHERE id = $1 FOR UPDATE`, [workflowId]);
      await client.query(
        `UPDATE workflows SET active_version_id = NULL, default_branch_id = NULL WHERE id = $1`,
        [workflowId],
      );
      await client.query(`UPDATE workflow_branches SET head_version_id = NULL WHERE workflow_id = $1`, [
        workflowId,
      ]);
      await client.query(`DELETE FROM workflows WHERE id = $1`, [workflowId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  // A pool whose clients stop after the rekey's DELETE until `release()`.
  const heldAfterDelete = (): { pool: Pool; arrived: Promise<void>; release: () => void } => {
    let arrive = (): void => undefined;
    let release = (): void => undefined;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const held = {
      connect: async (): Promise<PoolClient> => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text.trimStart().startsWith('DELETE')) {
              arrive();
              await released;
            }
            return result;
          },
          release: (err?: Error) => client.release(err),
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
    return { pool: held, arrived, release };
  };

  it('a workflow delete that starts while a rekey to it is under way waits for it, and neither deadlocks', async () => {
    const { workflowId, scratch } = await workflowWithThreads();
    const held = heldAfterDelete();
    const before = await deadlocks();
    try {
      const rekeying = new ThreadStore(held.pool).rekey(scratch, workflowId);
      await held.arrived;
      const deleting = deleteWorkflow(workflowId);
      await lockWaiter();
      held.release();
      await expect(rekeying).resolves.toBe(true);
      await expect(deleting).resolves.toBeUndefined();
    } finally {
      held.release();
    }
    expect(await threadsOf(workflowId)).toEqual([]);
    await pause(1_500);
    expect((await deadlocks()) - before).toBe(0);
  });

  it('rekeying to a workflow that is already gone drops its scratch thread, as the delete would have', async () => {
    const { workflowId, scratch } = await workflowWithThreads();
    await deleteWorkflow(workflowId);

    await expect(new ThreadStore(pool).rekey(scratch, workflowId)).resolves.toBe(false);

    const thread = await db.query(`SELECT 1 FROM composer_threads WHERE id = $1`, [scratch]);
    expect(thread.rows).toEqual([]);
  });
  it('a rekey to a workflow that is gone leaves alone a thread another session already moved to a live workflow', async () => {
    const [live, gone] = [randomUUID(), randomUUID()];
    await db.query(`INSERT INTO workflows (id, name) VALUES ($1, 'live'), ($2, 'gone')`, [live, gone]);
    const moved = await db.query<{ id: string }>(
      `INSERT INTO composer_threads (user_key, workflow_id) VALUES ('user_2', $1) RETURNING id`,
      [live],
    );
    await deleteWorkflow(gone);

    await expect(new ThreadStore(pool).rekey(moved.rows[0]!.id, gone)).resolves.toBe(false);

    expect(await threadsOf(live)).toEqual([moved.rows[0]!.id]);
  });
});
