import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { TriggerSignalsService } from './trigger-signals.service';

/**
 * The pointer/slot-move → reconcile signal seam (ADR 0018). MUST depend only on JobsModule, so
 * workflows/environments can enqueue reconciles without a module cycle back into the trigger layer.
 */
@Module({
  imports: [JobsModule],
  providers: [TriggerSignalsService],
  exports: [TriggerSignalsService],
})
export class TriggerSignalsModule {}
