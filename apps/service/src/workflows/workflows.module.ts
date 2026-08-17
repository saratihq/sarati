import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ComposeModule } from '../compose/compose.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { GenerationModule } from '../generation/generation.module';
import { RunsModule } from '../runs/runs.module';
import { TriggerSignalsModule } from '../triggers/trigger-signals.module';
import { BranchService } from './branch.service';
import { BranchesController } from './branches.controller';
import { DeployController } from './deploy.controller';
import { EnvPointersService } from './env-pointers.service';
import { DiffService } from './diff.service';
import { MergeOrchestrationService } from './merge-orchestration.service';
import { VersionsReadService } from './versions-read.service';
import { VersionsWriteService } from './versions-write.service';
import { WorkflowInvokeController } from './workflow-invoke.controller';
import { WorkflowInvokeService } from './workflow-invoke.service';
import { WorkflowLifecycleService } from './workflow-lifecycle.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowAccessService } from './workflow-access.service';
import { CallableWorkflowsService } from './callable-workflows.service';
import { WorkflowToolContractService } from './workflow-tool-contract.service';
import { WorkflowsReadService } from './workflows-read.service';
import { WorkflowsWriteController } from './workflows-write.controller';

@Module({
  // Environments: pointer environment_id dual-write. TriggerSignals: pointer moves enqueue a
  // reconcile. Generation: the action catalog for node auth. Compose: control types for the commit
  // gate. Runs: workflow-as-tool invocation fires the published version (ADR 0053).
  imports: [
    AuthModule,
    ComposeModule,
    EnvironmentsModule,
    GenerationModule,
    RunsModule,
    TriggerSignalsModule,
  ],
  controllers: [
    DeployController,
    WorkflowsWriteController,
    BranchesController,
    WorkflowInvokeController,
    WorkflowsController,
  ],
  providers: [
    WorkflowAccessService,
    CallableWorkflowsService,
    WorkflowToolContractService,
    WorkflowsReadService,
    VersionsReadService,
    DiffService,
    BranchService,
    VersionsWriteService,
    EnvPointersService,
    WorkflowInvokeService,
    WorkflowLifecycleService,
    MergeOrchestrationService,
  ],
  exports: [
    WorkflowAccessService,
    CallableWorkflowsService,
    WorkflowToolContractService,
    WorkflowsReadService,
    VersionsReadService,
    DiffService,
    BranchService,
    VersionsWriteService,
    EnvPointersService,
    WorkflowLifecycleService,
    WorkflowInvokeService,
  ],
})
export class WorkflowsModule {}
