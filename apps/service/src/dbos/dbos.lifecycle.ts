import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import type { EnvConfig } from '../config/env.config';
import { deriveDbosSystemDatabaseUrl } from './system-db-url';

/** Recovery version when `DBOS_APP_VERSION` is unset — must stay a CONSTANT (not DBOS's code hash)
 *  or every deploy orphans the runs in flight across it. */
export const DBOS_APP_VERSION_DEFAULT = 'orchestr-1';

/** Launches/stops the DBOS runtime on bootstrap, so module-load workflow registration precedes it. */
@Injectable()
export class DbosLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DbosLifecycle.name);
  private launched = false;

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (!env.dbosEnabled) {
      this.logger.log('DBOS disabled (DBOS_ENABLED=false)');
      return;
    }
    const systemDatabaseUrl = env.dbosSystemDatabaseUrl || deriveDbosSystemDatabaseUrl(env.databaseUrl);
    // Pin recovery identity so crash/deploy recovery is deterministic.
    const applicationVersion = env.dbosAppVersion || DBOS_APP_VERSION_DEFAULT;
    DBOS.setConfig({
      name: 'orchestr',
      systemDatabaseUrl,
      applicationVersion,
      ...(env.dbosExecutorId ? { executorID: env.dbosExecutorId } : {}),
    });
    await DBOS.launch();
    this.launched = true;
    this.logger.log(
      `DBOS launched (appVersion=${applicationVersion}, executorId=${env.dbosExecutorId || 'local'})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.launched) return;
    await DBOS.shutdown();
    this.launched = false;
  }
}
