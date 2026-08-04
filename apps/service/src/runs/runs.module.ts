import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DbosModule } from '../dbos/dbos.module';
import { JobsModule } from '../jobs/jobs.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { RunsController } from './runs.controller';
import { RunReaperJob } from './run-reaper.job';
import { RunReaperService } from './run-reaper.service';
import { RunsService } from './runs.service';

/** The orchestration runtime's HTTP surface, plus the reaper that sweeps crashed runs to a terminal state. */
@Module({
  imports: [AuthModule, RuntimeModule, DbosModule, JobsModule],
  controllers: [RunsController],
  providers: [RunsService, RunReaperService, RunReaperJob],
  exports: [RunsService, RunReaperService],
})
export class RunsModule {}
