import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResult } from 'pg';
import PgBoss from 'pg-boss';

import { errorMessage } from '../common/error-message';
import { SHUTDOWN_WAIT_MS, ShutdownDeadline } from '../common/shutdown-deadline';
import type { EnvConfig } from '../config/env.config';

/** pg-boss itself, private to this module: outside it a job is sent through {@link JobSender} and worked through {@link JobRegistry}. */
export const PG_BOSS = Symbol('PG_BOSS');

const JOBS_DATABASE = Symbol('JOBS_DATABASE');

class JobsDatabase implements PgBoss.Db {
  private readonly pool: Pool;
  private readonly queries = new Set<Promise<QueryResult>>();
  private closed = false;

  constructor(connectionString: string, logger: Logger) {
    this.pool = new Pool({ connectionString, application_name: 'pgboss' });
    this.pool.on('error', (err) => logger.error(`pg-boss error: ${err.message}`));
  }

  executeSql(text: string, values?: unknown[]): Promise<QueryResult> {
    if (this.closed) return Promise.reject(new Error('pg-boss has stopped: its database is closed'));
    const query = this.pool.query(text, values);
    this.queries.add(query);
    const forget = (): void => {
      this.queries.delete(query);
    };
    void query.then(forget, forget);
    return query;
  }

  pending(): Promise<unknown>[] {
    return [...this.queries];
  }

  close(): Promise<void> {
    this.closed = true;
    return this.pool.end();
  }
}

/** A worker's handler: the jobs it fetched, and a signal aborted as the service starts to stop. */
export type JobHandler<T> = (jobs: PgBoss.Job<T>[], signal: AbortSignal) => Promise<void>;

/** What a registration is handed: its queues, schedules and workers. */
export interface JobQueues {
  createQueue(name: string): Promise<void>;
  updateQueue(name: string, options: PgBoss.Queue): Promise<void>;
  schedule(name: string, cron: string): Promise<void>;
  work<T extends object = object>(name: string, handler: JobHandler<T>): Promise<void>;
}

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeUp = new Promise<false>((resolve) => (timer = setTimeout(resolve, ms, false)));
  try {
    return await Promise.race([work.then(() => true), timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

// pg-boss counts a retry at every fetch of a job after its first, so a copy keeps only the retries the job had left.
function sentAs(job: PgBoss.JobWithMetadata): PgBoss.SendOptions {
  return {
    priority: job.priority,
    retryLimit: job.retryLimit - job.retryCount,
    retryDelay: job.retryDelay,
    retryBackoff: job.retryBackoff,
    expireInSeconds: Number(job.expireInSeconds),
    ...(job.singletonKey === null ? {} : { singletonKey: job.singletonKey }),
    ...(job.deadLetter ? { deadLetter: job.deadLetter } : {}),
  };
}

/** Runs registrations one at a time, as concurrent ones deadlock pg-boss's schema creation on a cold database, and owns every worker: none attaches before {@link JobRegistry.start}, and a stop drains each. */
@Injectable()
export class JobRegistry implements BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRegistry.name);
  private chain: Promise<unknown> = Promise.resolve();
  private readonly queues = new Set<string>();
  private readonly unattached: Array<() => Promise<void>> = [];
  private started = false;
  private readonly inFlight = new Map<Promise<void>, string>();

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss | null,
    private readonly deadline: ShutdownDeadline,
  ) {}

  /** Runs `register` after every earlier registration has settled; resolves false when jobs are off. */
  async register(register: (queues: JobQueues) => Promise<void>): Promise<boolean> {
    const boss = this.boss;
    if (!boss) return false;
    const queues: JobQueues = {
      createQueue: (name) => boss.createQueue(name),
      updateQueue: (name, options) => boss.updateQueue(name, options),
      schedule: (name, cron) => boss.schedule(name, cron),
      work: (name, handler) => this.work(boss, name, handler),
    };
    const run = this.chain.then(() => register(queues));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    return true;
  }

  /** Attaches the workers registered so far, and every later one as it registers. */
  async start(): Promise<void> {
    this.started = true;
    for (const attach of this.unattached.splice(0)) await attach();
  }

  /** The handlers running, each job's hand-back among them. */
  pending(): Promise<void>[] {
    return [...this.inFlight.keys()];
  }

  /** Stops every worker fetching and waits, until the shutdown deadline, for its handlers running; before HTTP closes, so sends still land. */
  async beforeApplicationShutdown(): Promise<void> {
    const boss = this.boss;
    if (!boss) return;
    const ms = this.deadline.remainingMs();
    for (const queue of this.queues) await boss.offWork(queue);
    if (this.inFlight.size === 0) return;
    this.logger.log(
      `Shutting down: waiting up to ${ms} ms for ${this.inFlight.size} job(s) in flight: ${this.running()}`,
    );
    await settlesWithin(Promise.allSettled(this.inFlight.keys()), ms);
    if (this.inFlight.size > 0) {
      this.logger.warn(
        `Shutting down: stopped waiting for job(s) still running ${SHUTDOWN_WAIT_MS} ms into the stop: ${this.running()}`,
      );
    }
  }

  private async work<T extends object>(boss: PgBoss, name: string, handler: JobHandler<T>): Promise<void> {
    this.queues.add(name);
    const attach = async (): Promise<void> => {
      await boss.work<T>(name, { includeMetadata: true }, (jobs) => this.handle(boss, name, jobs, handler));
    };
    if (this.started) await attach();
    else this.unattached.push(attach);
  }

  private handle<T extends object>(
    boss: PgBoss,
    name: string,
    jobs: PgBoss.JobWithMetadata<T>[],
    handler: JobHandler<T>,
  ): Promise<void> {
    const stopping = this.deadline.signal;
    const running = stopping.aborted ? this.handBack(boss, jobs) : handler(jobs, stopping);
    this.inFlight.set(running, name);
    const forget = (): void => {
      this.inFlight.delete(running);
    };
    void running.then(forget, forget);
    return running;
  }

  // A job fetched as the stop began goes back to its queue as a copy, and the one fetched completes, spending no retry.
  private async handBack(boss: PgBoss, jobs: PgBoss.JobWithMetadata[]): Promise<void> {
    for (const job of jobs) {
      let copy: string | null;
      try {
        copy = await boss.send(job.name, job.data, sentAs(job));
      } catch (err) {
        this.logger.error(
          `Shutting down: could not hand ${job.name} job ${job.id} back to its queue, so pg-boss fails it: ${errorMessage(err)}`,
        );
        throw err;
      }
      this.logger.log(
        copy
          ? `Shutting down: handed ${job.name} job ${job.id} back to its queue as job ${copy}`
          : `Shutting down: left ${job.name} job ${job.id} to the job already waiting in its queue`,
      );
    }
  }

  /** The queues of the handlers running. */
  running(): string {
    return [...this.inFlight.values()].join(', ');
  }
}

/** Sends jobs: the one door to pg-boss outside this module, so a worker attaches only through {@link JobRegistry}. */
@Injectable()
export class JobSender {
  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss | null) {}

  /** Sends `data` to `queue`; resolves false, sending nothing, when jobs are off. */
  async send(queue: string, data: object, options: PgBoss.SendOptions = {}): Promise<boolean> {
    if (!this.boss) return false;
    await this.boss.send(queue, data, options);
    return true;
  }
}

@Injectable()
export class JobsLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsLifecycle.name);
  private stopped: Promise<void> | undefined;

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss | null,
    @Inject(JOBS_DATABASE) private readonly db: JobsDatabase | null,
    private readonly registry: JobRegistry,
    private readonly deadline: ShutdownDeadline,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.boss) {
      this.logger.log('pg-boss disabled (PGBOSS_ENABLED=false)');
      return;
    }
    this.boss.on('error', (err) => this.logger.error(`pg-boss error: ${err.message}`));
    await this.boss.start();
    this.logger.log('pg-boss started (schema: pgboss)');
  }

  /** Stops pg-boss once, however often asked: it waits, until the stop's deadline and no longer, for every job and hand-back still running, fails each one still running then for pg-boss to retry, and closes its database once no fetch, job or hand-back is left. */
  stop(): Promise<void> {
    if (!this.boss || !this.db) return Promise.resolve();
    this.stopped ??= this.stopNow(this.boss, this.db);
    return this.stopped;
  }

  private async stopNow(boss: PgBoss, db: JobsDatabase): Promise<void> {
    try {
      await this.quiet(() => this.registry.pending(), this.deadline);
      // pg-boss's own graceful wait gives a running job at least 1 s, checked every 500 ms, so it would outlast the deadline.
      await boss.stop({ graceful: false, close: false });
    } finally {
      await this.closeOnceQuiet(db);
    }
  }

  private async closeOnceQuiet(db: JobsDatabase): Promise<void> {
    const left = (): Promise<unknown>[] => [...db.pending(), ...this.registry.pending()];
    const close = (): Promise<void> =>
      db
        .close()
        .catch((err: unknown) => this.logger.error(`pg-boss's database did not close: ${errorMessage(err)}`));
    if (await this.quiet(left, this.deadline)) return close();
    this.logger.warn(
      `Shutting down: pg-boss's database stays open past the stop's deadline for ${db.pending().length} query(s) still at it and the job(s) still running (${this.registry.running() || 'none'}); it closes once they end`,
    );
    void this.quiet(left).then(close);
  }

  // A fetch that returns a job starts its handler, and a handler that ends starts pg-boss's completing query and clears its worker's jobs, each before a tick passes.
  private async quiet(left: () => Promise<unknown>[], deadline?: ShutdownDeadline): Promise<boolean> {
    for (;;) {
      const running = left();
      if (running.length > 0) {
        const settled = Promise.allSettled(running);
        if (!deadline) await settled;
        else if (!(await settlesWithin(settled, deadline.remainingMs()))) return false;
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (left().length === 0) return true;
    }
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}

/** pg-boss, private to this module, its tables in the `pgboss` schema: queues register through {@link JobRegistry}, and jobs are sent through {@link JobSender}. */
@Module({
  providers: [
    {
      provide: JOBS_DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>): JobsDatabase | null => {
        const env = config.get('env', { infer: true });
        if (!env.pgBossEnabled) return null;
        return new JobsDatabase(env.databaseUrl, new Logger(JobsLifecycle.name));
      },
    },
    {
      provide: PG_BOSS,
      inject: [JOBS_DATABASE],
      useFactory: (db: JobsDatabase | null): PgBoss | null =>
        db ? new PgBoss({ db, schema: 'pgboss' }) : null,
    },
    JobsLifecycle,
    JobRegistry,
    JobSender,
  ],
  exports: [JobRegistry, JobSender, JobsLifecycle],
})
export class JobsModule {}
