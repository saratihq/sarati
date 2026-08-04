import { Module } from '@nestjs/common';

import { RunsModule } from '../runs/runs.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { SubWorkflowRunnerService } from './sub-workflow-runner.service';

/**
 * Wires the sub-workflow-as-tool runner (ADR 0045 §3). A leaf module imported ONLY by AppModule, so
 * it can compose Runs/Runtime/Workflows without any of them depending back on it — no module cycle.
 */
@Module({
  imports: [RunsModule, RuntimeModule, WorkflowsModule],
  providers: [SubWorkflowRunnerService],
  exports: [SubWorkflowRunnerService],
})
export class SubWorkflowModule {}
