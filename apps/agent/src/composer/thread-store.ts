import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import type { SequencedComposerEvent } from './protocol';

/**
 * Durable composer threads (Postgres). A thread is the ONE conversation a
 * user has per workflow (workflow_id NULL = the pre-save compose scratch
 * thread) — the schema lives in workflow-service (`007_composer_threads.sql`);
 * this store is its only reader/writer.
 *
 * Fail-soft by design: no DATABASE_URL → memory-only, exactly the pre-thread
 * behavior. Event writes are async write-through — a failed insert logs and
 * never breaks the live stream (the in-memory session stays the hot path).
 */

/** Provided by ComposerModule: a pg Pool when DATABASE_URL is set, else null. */
export const THREAD_PG_POOL = Symbol('THREAD_PG_POOL');

export interface ThreadRecord {
  id: string;
  userKey: string;
  workflowId: string | null;
  sdkSessionId: string | null;
  lastSeq: number;
}

interface ThreadRow {
  id: string;
  user_key: string;
  workflow_id: string | null;
  sdk_session_id: string | null;
  last_seq: number;
}

const THREAD_COLUMNS = 'id, user_key, workflow_id, sdk_session_id, last_seq';

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    userKey: row.user_key,
    workflowId: row.workflow_id,
    sdkSessionId: row.sdk_session_id,
    lastSeq: row.last_seq,
  };
}

@Injectable()
export class ThreadStore implements OnApplicationShutdown {
  private readonly logger = new Logger(ThreadStore.name);
  private readonly pool: Pool | null;
  /** Per-thread write chain: events arrive in the database in emit order. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(@Optional() @Inject(THREAD_PG_POOL) pool?: Pool | null) {
    this.pool = pool ?? null;
    if (!this.pool) {
      this.logger.warn(
        'DATABASE_URL is not set — composer threads are memory-only (no durable transcripts).',
      );
    }
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  /** Find-or-create the (user, workflow) thread — workflowId null = the scratch thread. */
  async resolve(userKey: string, workflowId: string | null): Promise<ThreadRecord> {
    const pool = this.mustPool();
    const found = await this.select(pool, userKey, workflowId);
    if (found) return found;
    const inserted = await pool.query<ThreadRow>(
      `INSERT INTO composer_threads (user_key, workflow_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING ${THREAD_COLUMNS}`,
      [userKey, workflowId],
    );
    if (inserted.rows[0]) return toRecord(inserted.rows[0]);
    // Lost a concurrent create — the winner's row is the thread.
    const winner = await this.select(pool, userKey, workflowId);
    if (!winner) throw new Error('composer thread vanished between insert and select');
    return winner;
  }

  /**
   * Clear (owner, 2026-07-14): drop the (user, workflow) thread — events
   * cascade with the row. Returns false when there was nothing to clear or
   * persistence is off (memory-only mode clears client-side only).
   */
  async deleteThread(userKey: string, workflowId: string | null): Promise<{ threadId: string } | null> {
    if (!this.enabled) return null;
    const pool = this.mustPool();
    const found = await this.select(pool, userKey, workflowId);
    if (!found) return null;
    await pool.query(`DELETE FROM composer_threads WHERE id = $1`, [found.id]);
    return { threadId: found.id };
  }

  /**
   * Async write-through of one emitted event. Non-blocking: failures log and
   * the stream continues; the per-thread chain keeps arrival order. The PK
   * (thread_id, seq) makes duplicate writes (double sessions, retries) inert.
   */
  append(threadId: string, event: SequencedComposerEvent): void {
    if (!this.pool) return;
    const pool = this.pool;
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const { seq, ...wire } = event;
        await pool.query(
          `WITH ins AS (
             INSERT INTO composer_thread_events (thread_id, seq, event)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT DO NOTHING
           )
           UPDATE composer_threads
              SET last_seq = GREATEST(last_seq, $2), updated_at = now()
            WHERE id = $1`,
          [threadId, seq, JSON.stringify(wire)],
        );
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `event write-through failed (thread ${threadId}, seq ${event.seq}): ${messageOf(err)}`,
        );
      })
      .finally(() => {
        if (this.chains.get(threadId) === next) this.chains.delete(threadId);
      });
    this.chains.set(threadId, next);
  }

  /** Remember the SDK session id so a rehydrated thread can resume its transcript. */
  recordSdkSession(threadId: string, sdkSessionId: string): void {
    if (!this.pool) return;
    void this.pool
      .query(`UPDATE composer_threads SET sdk_session_id = $2, updated_at = now() WHERE id = $1`, [
        threadId,
        sdkSessionId,
      ])
      .catch((err: unknown) => {
        this.logger.warn(`sdk session update failed (thread ${threadId}): ${messageOf(err)}`);
      });
  }

  /**
   * The composer's accept path re-keyed a scratch session to the created
   * workflow: move the thread with it. If a thread for (user, workflow)
   * already exists, the SCRATCH thread's events win — they ARE the history —
   * so the standing row is dropped and the scratch thread takes the key.
   */
  async rekey(threadId: string, workflowId: string): Promise<void> {
    const pool = this.mustPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM composer_threads
          WHERE user_key = (SELECT user_key FROM composer_threads WHERE id = $1)
            AND workflow_id = $2 AND id <> $1`,
        [threadId, workflowId],
      );
      await client.query(`UPDATE composer_threads SET workflow_id = $2, updated_at = now() WHERE id = $1`, [
        threadId,
        workflowId,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The thread's event log after `afterSeq`, in emit order — the attach replay source. */
  async loadEvents(threadId: string, afterSeq: number): Promise<SequencedComposerEvent[]> {
    const pool = this.mustPool();
    const res = await pool.query<{ seq: number; event: Omit<SequencedComposerEvent, 'seq'> }>(
      `SELECT seq, event FROM composer_thread_events
        WHERE thread_id = $1 AND seq > $2
        ORDER BY seq`,
      [threadId, afterSeq],
    );
    return res.rows.map((r) => ({ ...r.event, seq: r.seq }) as SequencedComposerEvent);
  }

  /**
   * Whether the SDK's transcript file for a stored session id still exists —
   * the resume gate after rehydration. Gone (restart elsewhere, cleanup) →
   * the next turn starts a fresh SDK session; the prompt re-seeds context
   * (canvas state travels with every message).
   */
  transcriptExists(sdkSessionId: string): boolean {
    if (!/^[0-9a-f-]{36}$/i.test(sdkSessionId)) return false;
    const root = join(homedir(), '.claude', 'projects');
    try {
      return readdirSync(root).some((dir) => existsSync(join(root, dir, `${sdkSessionId}.jsonl`)));
    } catch {
      return false; // no SDK state directory at all — nothing to resume
    }
  }

  /** Test/shutdown helper: wait for every in-flight write chain to settle. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
    await this.pool?.end();
  }

  private mustPool(): Pool {
    if (!this.pool) throw new Error('thread persistence is disabled (DATABASE_URL is not set)');
    return this.pool;
  }

  private async select(pool: Pool, userKey: string, workflowId: string | null): Promise<ThreadRecord | null> {
    const res = await pool.query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM composer_threads
        WHERE user_key = $1 AND workflow_id IS NOT DISTINCT FROM $2`,
      [userKey, workflowId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
