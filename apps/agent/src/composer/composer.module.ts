import { Logger, Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Pool } from 'pg';

import type { EnvConfig } from '../config/env.config';
import { ComposerAuthGuard } from './composer-auth.guard';
import { ComposerEnabledGuard } from './composer-enabled.guard';
import { ComposerStatusController } from './composer-status.controller';
import { ComposerController } from './composer.controller';
import { ComposerService, QUERY_FN } from './composer.service';
import { PendingAnswers } from './pending-answers';
import { SessionStore } from './sessions';
import { THREAD_PG_POOL, ThreadStore } from './thread-store';
import { WorkflowServiceClient } from './workflow-client';

@Module({
  controllers: [ComposerStatusController, ComposerController],
  providers: [
    ComposerService,
    ComposerAuthGuard,
    ComposerEnabledGuard,
    SessionStore,
    PendingAnswers,
    WorkflowServiceClient,
    ThreadStore,
    {
      provide: THREAD_PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>): Pool | null => {
        const url = config.get('env', { infer: true }).databaseUrl;
        if (!url) return null;
        const pool = new Pool({ connectionString: url, max: 5 });
        // An idle-client error must degrade to a logged warning, never crash
        // the process (an unhandled Pool 'error' event is fatal in Node).
        pool.on('error', (err) => new Logger('ThreadPgPool').warn(`idle client error: ${err.message}`));
        return pool;
      },
    },
    { provide: QUERY_FN, useValue: query },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
  ],
})
export class ComposerModule {}
