import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { errorMessage } from '../common/error-message';
import { ShuttingDown } from '../common/shutdown-deadline';
import type { EnvConfig } from '../config/env.config';
import { JobsLifecycle } from '../jobs/jobs.module';
import { launchDbos } from './dbos-config';
import { DbosRuntime } from './dbos-runtime';
import { RecoveryGuard } from './recovery-guard';
import { recoveryIdentityOf } from './recovery-identity';
import { systemDatabaseUrlOf } from './system-db-url';

/** Launches/stops the DBOS runtime on bootstrap, so module-load workflow registration precedes it, and tells the runtime's callers whether it launched. */
@Injectable()
export class DbosLifecycle implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(DbosLifecycle.name);
  private launched = false;

  constructor(
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly runtime: DbosRuntime,
    private readonly jobs: JobsLifecycle,
    @Optional() private readonly guard?: RecoveryGuard,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (!env.dbosEnabled) {
      this.runtime.notLaunched(new Error('DBOS is off (DBOS_ENABLED=false)'));
      this.logger.log('DBOS disabled (DBOS_ENABLED=false)');
      return;
    }
    const { applicationVersion, executorId } = recoveryIdentityOf(env);
    await this.logRunsInFlight();
    try {
      await launchDbos({
        name: 'orchestr',
        systemDatabaseUrl: systemDatabaseUrlOf(env),
        applicationVersion,
        executorID: executorId,
      });
    } catch (err) {
      this.runtime.notLaunched(new Error(`DBOS failed to launch: ${errorMessage(err)}`));
      throw err;
    }
    this.launched = true;
    this.runtime.launched();
    this.logger.log(`DBOS launched (appVersion=${applicationVersion}, executorId=${executorId})`);
  }

  // A stop that comes before the launch fails every call still waiting for it, so nothing waits on DBOS past the stop.
  onModuleDestroy(): void {
    this.runtime.notLaunched(new ShuttingDown());
  }

  // Counted before launch starts recovering them, so the counts cover every legacy-engine run this launch recovers; each is judged again then.
  private async logRunsInFlight(): Promise<void> {
    if (!this.guard) return;
    try {
      const { resume, fail, ended } = await this.guard.legacyRuns();
      this.logger.log(
        `Runs v0.2.24 or earlier started, in flight at boot: ${resume} can resume, ${fail} can't be resumed safely and will fail, ${ended} had already ended`,
      );
    } catch (err) {
      this.logger.warn(
        `Couldn't judge the runs v0.2.24 or earlier started, in flight at boot: ${errorMessage(err)}`,
      );
    }
  }

  // pg-boss stops first: DBOS's own stop waits, with no limit, for every workflow still running or parked.
  async onApplicationShutdown(): Promise<void> {
    await this.jobs.stop();
    if (!this.launched) return;
    await DBOS.shutdown();
    this.launched = false;
  }
}
