import type { Pool, PoolClient } from 'pg';

import { ThreadStore } from './thread-store';
import type { SequencedComposerEvent } from './protocol';

/**
 * The store's risky parts against a scripted pg Pool: find-or-create keying
 * (incl. the losing side of a concurrent create), write-through ordering and
 * failure isolation, the scratch→workflow rekey transaction, and the
 * DATABASE_URL-unset fallback.
 */

type QueryCall = { text: string; values?: unknown[] };

function poolOf(respond: (call: QueryCall) => Promise<{ rows: unknown[]; rowCount: number }>): {
  pool: Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const pool = {
    query: (text: string, values?: unknown[]) => {
      const call = { text, values };
      calls.push(call);
      return respond(call);
    },
  } as unknown as Pool;
  return { pool, calls };
}

const THREAD_ROW = {
  id: 'thread-1',
  user_key: 'user_1',
  workflow_id: 'wf-1',
  sdk_session_id: null,
  last_seq: 3,
};

describe('ThreadStore.resolve (find-or-create)', () => {
  it('returns the existing (user, workflow) thread without inserting', async () => {
    const { pool, calls } = poolOf((c) =>
      c.text.includes('SELECT')
        ? Promise.resolve({ rows: [THREAD_ROW], rowCount: 1 })
        : Promise.reject(new Error('unexpected insert')),
    );
    const store = new ThreadStore(pool);
    const thread = await store.resolve('user_1', 'wf-1');
    expect(thread).toEqual({
      id: 'thread-1',
      userKey: 'user_1',
      workflowId: 'wf-1',
      sdkSessionId: null,
      lastSeq: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['user_1', 'wf-1']);
  });

  it('creates the row when missing — null workflow keys the ONE scratch thread', async () => {
    const { pool, calls } = poolOf((c) =>
      c.text.includes('INSERT')
        ? Promise.resolve({ rows: [{ ...THREAD_ROW, workflow_id: null, last_seq: 0 }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 }),
    );
    const store = new ThreadStore(pool);
    const thread = await store.resolve('user_1', null);
    expect(thread.workflowId).toBeNull();
    expect(thread.lastSeq).toBe(0);
    expect(calls.map((c) => c.text.includes('INSERT'))).toEqual([false, true]);
    expect(calls[1]!.values).toEqual(['user_1', null]);
  });

  it('losing a concurrent create falls back to the winner row (ON CONFLICT DO NOTHING)', async () => {
    let selects = 0;
    const { pool } = poolOf((c) => {
      if (c.text.includes('INSERT')) return Promise.resolve({ rows: [], rowCount: 0 });
      selects += 1;
      return selects === 1
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : Promise.resolve({ rows: [THREAD_ROW], rowCount: 1 });
    });
    const store = new ThreadStore(pool);
    const thread = await store.resolve('user_1', 'wf-1');
    expect(thread.id).toBe('thread-1');
    expect(selects).toBe(2);
  });
});

describe('ThreadStore.append (async write-through)', () => {
  const evt = (seq: number): SequencedComposerEvent => ({
    event: 'assistant_text',
    data: { text: `t${seq}` },
    seq,
  });

  it('writes events strictly in arrival order (per-thread chain)', async () => {
    const settled: number[] = [];
    let release1: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release1 = r;
    });
    let n = 0;
    const { pool, calls } = poolOf(() => {
      n += 1;
      const mine = n;
      if (mine === 1) return gate.then(() => (settled.push(mine), { rows: [], rowCount: 0 }));
      settled.push(mine);
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const store = new ThreadStore(pool);
    store.append('thread-1', evt(1));
    store.append('thread-1', evt(2));
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1); // the second write WAITS for the first
    release1();
    await store.flush();
    expect(settled).toEqual([1, 2]);
    expect(calls[1]!.values?.[1]).toBe(2);
    // The stored payload is the wire event without the seq column duplicate.
    expect(JSON.parse(calls[0]!.values?.[2] as string)).toEqual({
      event: 'assistant_text',
      data: { text: 't1' },
    });
  });

  it('a failed insert logs and never breaks the chain — later events still land', async () => {
    let n = 0;
    const { pool, calls } = poolOf(() => {
      n += 1;
      return n === 1
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({ rows: [], rowCount: 0 });
    });
    const store = new ThreadStore(pool);
    store.append('thread-1', evt(1));
    store.append('thread-1', evt(2));
    await store.flush();
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.values?.[1]).toBe(2);
  });

  it('is a silent no-op when persistence is disabled', () => {
    const store = new ThreadStore(null);
    expect(store.enabled).toBe(false);
    expect(() => store.append('thread-1', evt(1))).not.toThrow();
  });
});

describe('ThreadStore.rekey (scratch → created workflow)', () => {
  function clientPool(fail?: string): { pool: Pool; statements: string[] } {
    const statements: string[] = [];
    const client = {
      query: (text: string) => {
        statements.push(text.trim().split(/\s+/, 1)[0]!.toUpperCase());
        if (fail && text.includes(fail)) return Promise.reject(new Error('boom'));
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
    return { pool, statements };
  }

  it('drops the standing (user, workflow) thread and takes the key — scratch history wins', async () => {
    const { pool, statements } = clientPool();
    await new ThreadStore(pool).rekey('thread-scratch', 'wf-new');
    expect(statements).toEqual(['BEGIN', 'DELETE', 'UPDATE', 'COMMIT']);
  });

  it('rolls back on failure and rethrows (the caller logs, the stream continues)', async () => {
    const { pool, statements } = clientPool('UPDATE');
    await expect(new ThreadStore(pool).rekey('thread-scratch', 'wf-new')).rejects.toThrow('boom');
    expect(statements).toEqual(['BEGIN', 'DELETE', 'UPDATE', 'ROLLBACK']);
  });
});

describe('ThreadStore.loadEvents / transcriptExists', () => {
  it('maps rows back to the sequenced wire events, after the given seq', async () => {
    const { pool, calls } = poolOf(() =>
      Promise.resolve({
        rows: [
          { seq: 2, event: { event: 'user_message', data: { text: 'hi' } } },
          { seq: 3, event: { event: 'done', data: { session_id: 's', duration_ms: 1 } } },
        ],
        rowCount: 2,
      }),
    );
    const events = await new ThreadStore(pool).loadEvents('thread-1', 1);
    expect(events).toEqual([
      { event: 'user_message', data: { text: 'hi' }, seq: 2 },
      { event: 'done', data: { session_id: 's', duration_ms: 1 }, seq: 3 },
    ]);
    expect(calls[0]!.values).toEqual(['thread-1', 1]);
  });

  it('transcriptExists rejects non-uuid ids and missing files', () => {
    const store = new ThreadStore(null);
    expect(store.transcriptExists('../../etc/passwd')).toBe(false);
    expect(store.transcriptExists('00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});
