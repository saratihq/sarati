import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { AGENT_STEP_SINK } from './agent';
import { AgentStepBus } from './agent-step-bus';
import { BlobStoreModule } from './blob-store.module';
import { CodeRunner } from './code-runner';
import { DagInterpreter } from './dag-interpreter';
import { RunRecorderService } from './run-recorder.service';
import { RuntimeCompiler } from './runtime-compiler';

/**
 * The orchestration runtime — ONE engine (slice 4): the gating-scheduler `DagInterpreter`
 * over a `DagPlan`, with per-node execution in `base-plan-interpreter.ts`. `RuntimeCompiler`
 * produces that plan from either a `WorkflowIR` or a raw client `RunPlan`.
 */
@Module({
  imports: [ProvidersModule, BlobStoreModule],
  providers: [
    DagInterpreter,
    RunRecorderService,
    RuntimeCompiler,
    CodeRunner,
    // One in-process singleton wires both ends of the live agent step stream:
    // the subscribe surface, and the interpreter's publish sink behind AGENT_STEP_SINK.
    AgentStepBus,
    { provide: AGENT_STEP_SINK, useExisting: AgentStepBus },
  ],
  exports: [DagInterpreter, RunRecorderService, RuntimeCompiler, CodeRunner, AgentStepBus],
})
export class RuntimeModule {}
