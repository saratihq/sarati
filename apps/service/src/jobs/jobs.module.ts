import { Inject, Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';

import type { EnvConfig } from '../config/env.config';

export const PG_BOSS = Symbol('PG_BOSS');

@Injectable()
export class JobsLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsLifecycle.name);

  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss | null) {}

  async onModuleInit(): Promise<void> {
    if (!this.boss) {
      this.logger.log('pg-boss disabled (PGBOSS_ENABLED=false)');
      return;
    }
    this.boss.on('error', (err) => this.logger.error(`pg-boss error: ${err.message}`));
    await this.boss.start();
    this.logger.log('pg-boss started (schema: pgboss)');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.boss) return;
    await this.boss.stop({ graceful: true });
  }
}

/**
 * pg-boss wiring (ADR 0037): this module owns only the queue lifecycle — feature modules
 * register their own jobs. Its tables live in a separate `pgboss` schema, not the app schema.
 */
@Module({
  providers: [
    {
      provide: PG_BOSS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>): PgBoss | null => {
        const env = config.get('env', { infer: true });
        if (!env.pgBossEnabled) return null;
        return new PgBoss({ connectionString: env.databaseUrl, schema: 'pgboss' });
      },
    },
    JobsLifecycle,
  ],
  exports: [PG_BOSS],
})
export class JobsModule {}
