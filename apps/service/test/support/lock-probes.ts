import type { INestApplication } from '@nestjs/common';
import type { Client } from 'pg';
import { EntityManager } from 'typeorm';

import { EventsService, type DomainEventInput } from '../../src/events/events.service';

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
  /** Resolves once `count` backends of the database wait on a lock; throws after five seconds. */
  lockWaiters: (count: number) => Promise<void>;
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

  const lockWaiters = async (count: number): Promise<void> => {
    for (let i = 0; i < 200; i++) {
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
