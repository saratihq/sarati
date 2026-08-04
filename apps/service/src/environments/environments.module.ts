import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TriggerSignalsModule } from '../triggers/trigger-signals.module';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService } from './environments.service';

/** Named environments (ADR 0014). Must stay near-leaf — workflows, triggers and connections all import it. */
@Module({
  imports: [AuthModule, TriggerSignalsModule],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
