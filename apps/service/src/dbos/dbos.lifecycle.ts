import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { launchDbos } from './dbos-config';
import { RecoveryGuard } from './recovery-guard';
import { recoveryIdentityOf } from './recovery-identity';
import { systemDatabaseUrlOf } from './system-db-url';

/** Launches/stops the DBOS runtime on bootstrap, so module-load workflow registration precedes it. */
@Injectable()
export class DbosLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DbosLifecycle.name);
  private launched = false;

  constructor(
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    @Optional() private readonly guard?: RecoveryGuard,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (!env.dbosEnabled) {
      this.logger.log('DBOS disabled (DBOS_ENABLED=false)');
      return;
    }
    const { applicationVersion, executorId } = recoveryIdentityOf(env);
    await this.logRunsInFlight();
    await launchDbos({
      name: 'orchestr',
      systemDatabaseUrl: systemDatabaseUrlOf(env),
      applicationVersion,
      executorID: executorId,
    });
    this.launched = true;
    this.logger.log(`DBOS launched (appVersion=${applicationVersion}, executorId=${executorId})`);
  }

  // Counted before launch starts recovering them, so the counts cover every run in flight; each is judged again then.
  private async logRunsInFlight(): Promise<void> {
    if (!this.guard) return;
    try {
      const { resume, fail, ended } = await this.guard.legacyRuns();
      this.logger.log(
        `Runs an earlier version started, in flight at boot: ${resume} can resume, ${fail} can't be resumed safely and will fail, ${ended} had already ended`,
      );
    } catch (err) {
      this.logger.warn(
        `Couldn't judge the runs an earlier version started, in flight at boot: ${errorMessage(err)}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.launched) return;
    await DBOS.shutdown();
    this.launched = false;
  }
}
