import type { Pool, PoolClient } from 'pg';

// Two-key advisory locks live apart from the one-key ones pg-boss and DBOS take.
const ACTIVATION_LOCK_SPACE = 7301;

/** Run `work` holding the activation's lock, waiting for it, so a teardown or stand-up never overlaps a poll. */
export async function withActivationLock<T>(
  pool: Pool,
  activationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  return releasing(client, async () => {
    await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [ACTIVATION_LOCK_SPACE, activationId]);
    return holding(client, activationId, work);
  });
}

/** Run `work` holding the activation's lock if it is free; `null`, without waiting, while another holder has it. */
export async function ifActivationUnlocked<T>(
  pool: Pool,
  activationId: string,
  work: () => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  return releasing(client, async () => {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
      [ACTIVATION_LOCK_SPACE, activationId],
    );
    return rows[0]?.locked ? holding(client, activationId, work) : null;
  });
}

async function holding<T>(client: PoolClient, activationId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [ACTIVATION_LOCK_SPACE, activationId]);
  }
}

async function releasing<T>(client: PoolClient, body: () => Promise<T>): Promise<T> {
  try {
    const result = await body();
    client.release();
    return result;
  } catch (err) {
    // A session lock lasts as long as its connection, so one that may still hold it is closed, not pooled.
    client.release(true);
    throw err;
  }
}
