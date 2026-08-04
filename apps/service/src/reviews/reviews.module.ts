import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RunsModule } from '../runs/runs.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { MergeProbeService } from './merge-probe.service';
import { ReviewProposalService } from './review-proposal.service';
import { ReviewTestService } from './review-test.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

// moment `ReviewsModule` is added there.
@Module({
  imports: [AuthModule, WorkflowsModule, RunsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, ReviewTestService, MergeProbeService, ReviewProposalService],
  exports: [ReviewsService, ReviewProposalService],
})
export class ReviewsModule {}
