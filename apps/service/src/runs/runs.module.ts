import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DbosModule } from '../dbos/dbos.module';
import { JobsModule } from '../jobs/jobs.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { ClaimResender } from './claim-resender';
import { RunsController } from './runs.controller';
import { RunReaperJob } from './run-reaper.job';
import { RunReaperService } from './run-reaper.service';
import { RunsService } from './runs.service';

/** The orchestration runtime's HTTP surface, the reaper that sweeps crashed runs to a terminal state, and the resender of claimed decisions. */
@Module({
  imports: [AuthModule, RuntimeModule, DbosModule, JobsModule],
  controllers: [RunsController],
  providers: [RunsService, RunReaperService, RunReaperJob, ClaimResender],
  exports: [RunsService, RunReaperService],
})
export class RunsModule {}
