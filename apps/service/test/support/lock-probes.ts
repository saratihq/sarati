import type { INestApplication } from '@nestjs/common';
import type { Client } from 'pg';
import { EntityManager } from 'typeorm';

import { EventsService, type DomainEventInput } from '../../src/events/events.service';
import type { RunRecorderService } from '../../src/runtime/run-recorder.service';

/** A promise and the function that settles it. */
export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A hold on a request at one point, until it is released or restored. */
export interface Hold {
  arrived: Promise<void>;
  release: () => void;
  restore: () => void;
}

/** Resolves once `arrived` does; rejects, naming `what`, if `ms` pass first. */
export function reached(arrived: Promise<void>, what: string, ms = 5_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} never reached its hold`)), ms);
    void arrived.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** `hold`, its arrival bounded as `reached` bounds it, timed from when it is awaited. */
export const bounded = (hold: Hold, what: string): Hold => ({
  ...hold,
  get arrived() {
    return reached(hold.arrived, what);
  },
});

/** A hold on a wait's resume; `failed` says whether its transaction was made to fail. */
export interface ResumeHold extends Hold {
  failed: () => boolean;
}

/**
 * Holds the first resume a wait records that `match` accepts until it is released or restored.
 * Given `failing`, that resume's transaction then fails as a lost connection would, and the resume logs it.
 */
export function holdResume(
  recorder: RunRecorderService,
  {
    match = () => true,
    failing,
  }: { match?: (scopedRunId: string, stepKey: string) => boolean; failing?: EntityManager } = {},
): ResumeHold {
  const record = recorder.stepResumed.bind(recorder);
  const arrived = deferred();
  const released = deferred();
  let held = false;
  let failed = false;
  const spy = jest
    .spyOn(recorder, 'stepResumed')
    .mockImplementation(async (scopedRunId, stepKey, answered) => {
      if (held || !match(scopedRunId, stepKey)) return record(scopedRunId, stepKey, answered);
      held = true;
      arrived.resolve();
      await released.promise;
      if (!failing) return record(scopedRunId, stepKey, answered);
      const lost = jest.spyOn(failing, 'transaction').mockImplementationOnce(() => {
        failed = true;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      });
      try {
        return await record(scopedRunId, stepKey, answered);
      } finally {
        lost.mockRestore();
      }
    });
  return {
    arrived: arrived.promise,
    release: released.resolve,
    restore: () => {
      released.resolve();
      spy.mockRestore();
    },
    failed: () => failed,
  };
}

/** Holds on a suite's requests and reads of its database's locks, each read from the app and client when it runs. */
export interface LockProbes {
  /** Holds each transaction that emits `type`, just before or just after that emit, the nth until `release(n)` or `restore()`. */
  gateEmits: (
    type: string,
    at?: 'before' | 'after',
  ) => {
    arrived: (n: number) => Promise<void>;
    release: (n: number) => void;
    restore: () => void;
  };
  /** Holds the first query whose SQL matches `sql`, just before or just after it runs. */
  holdQuery: (sql: RegExp, at?: 'before' | 'after') => Hold;
  /** Resolves once `count` backends of the database wait on a lock; throws after `tries` reads 25 ms apart (five seconds). */
  lockWaiters: (count: number, tries?: number) => Promise<void>;
  /** The database's deadlock count. */
  deadlocks: () => Promise<number>;
  /** The deadlocks since `before`, read 1.5 s on: Postgres 14 counts one at once, 15+ as the deadlocked backend idles (it waited deadlock_timeout, past the second 15+ keeps between reports), or up to 10 s later if another backend is reporting at that instant. */
  deadlocksSince: (before: number) => Promise<number>;
}

export function lockProbes(app: () => INestApplication, db: () => Client): LockProbes {
  const deadlocks = async (): Promise<number> => {
    const { rows } = await db().query<{ deadlocks: string }>(
      `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`,
    );
    return Number(rows[0]!.deadlocks);
  };

  const deadlocksSince = async (before: number): Promise<number> => {
    await pause(1_500);
    return (await deadlocks()) - before;
  };

  const lockWaiters = async (count: number, tries = 200): Promise<void> => {
    for (let i = 0; i < tries; i++) {
      const { rows } = await db().query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows.length >= count) return;
      await pause(25);
    }
    throw new Error(`never saw ${count} lock waiter(s)`);
  };

  const gateEmits: LockProbes['gateEmits'] = (type, at = 'before') => {
    const events = app().get(EventsService);
    const emit = events.emit.bind(events);
    const gates: Array<{ arrived: Deferred; released: Deferred }> = [];
    const nth = (n: number): { arrived: Deferred; released: Deferred } =>
      (gates[n] ??= { arrived: deferred(), released: deferred() });
    let seen = 0;
    const spy = jest.spyOn(events, 'emit').mockImplementation(async (em, event: DomainEventInput) => {
      if (event.type !== type) return emit(em, event);
      const gate = nth(seen++);
      if (at === 'after') await emit(em, event);
      gate.arrived.resolve();
      await gate.released.promise;
      if (at === 'before') await emit(em, event);
    });
    return {
      arrived: (n) => nth(n).arrived.promise,
      release: (n) => nth(n).released.resolve(),
      restore: () => {
        for (const gate of gates) gate.released.resolve();
        spy.mockRestore();
      },
    };
  };

  const holdQuery: LockProbes['holdQuery'] = (sql, at = 'before') => {
    const query = EntityManager.prototype.query;
    const arrived = deferred();
    const released = deferred();
    let held = false;
    const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      text: string,
      params?: Parameters<EntityManager['query']>[1],
    ) {
      if (held || !sql.test(text)) return query.call(this, text, params);
      held = true;
      const result: unknown = at === 'after' ? await query.call(this, text, params) : undefined;
      arrived.resolve();
      await released.promise;
      return at === 'after' ? result : query.call(this, text, params);
    });
    return {
      arrived: arrived.promise,
      release: released.resolve,
      restore: () => {
        released.resolve();
        spy.mockRestore();
      },
    };
  };

  return { gateEmits, holdQuery, lockWaiters, deadlocks, deadlocksSince };
}
