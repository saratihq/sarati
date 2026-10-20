import { Module } from '@nestjs/common';

import { RuntimeModule } from '../runtime/runtime.module';
import { DbosLifecycle } from './dbos.lifecycle';
import { DbosRuntime } from './dbos-runtime';
import { RecoveryGuard } from './recovery-guard';

/** DBOS durable-execution runtime; always in the graph, but only launched when `DBOS_ENABLED`. */
@Module({
  imports: [RuntimeModule],
  providers: [DbosRuntime, DbosLifecycle, RecoveryGuard],
  exports: [DbosRuntime],
})
export class DbosModule {}
