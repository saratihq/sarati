import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { RecoveryGuard } from './recovery-guard';
import { systemDatabaseUrlOf } from './system-db-url';

/** Recovery version when `DBOS_APP_VERSION` is unset — must stay a CONSTANT (not DBOS's code hash)
 *  or every deploy orphans the runs in flight across it. */
export const DBOS_APP_VERSION_DEFAULT = 'orchestr-1';

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
    const systemDatabaseUrl = systemDatabaseUrlOf(env);
    // Pin recovery identity so crash/deploy recovery is deterministic.
    const applicationVersion = env.dbosAppVersion || DBOS_APP_VERSION_DEFAULT;
    DBOS.setConfig({
      name: 'orchestr',
      systemDatabaseUrl,
      applicationVersion,
      ...(env.dbosExecutorId ? { executorID: env.dbosExecutorId } : {}),
    });
    await this.logRunsInFlight();
    await DBOS.launch();
    this.launched = true;
    this.logger.log(
      `DBOS launched (appVersion=${applicationVersion}, executorId=${env.dbosExecutorId || 'local'})`,
    );
  }

  // Counted before launch starts recovering them, so the counts cover every run in flight; each is judged again then.
  private async logRunsInFlight(): Promise<void> {
    if (!this.guard) return;
    try {
      const { resume, fail, ended } = await this.guard.legacyRuns();
      this.logger.log(
        `Runs in flight at boot: ${resume} can resume, ${fail} can't be resumed safely and will fail, ${ended} had already ended`,
      );
    } catch (err) {
      this.logger.warn(`Couldn't judge the runs in flight at boot: ${errorMessage(err)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.launched) return;
    await DBOS.shutdown();
    this.launched = false;
  }
}
