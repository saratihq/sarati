import { Injectable } from '@nestjs/common';

import { compileWorkflowIrDag } from '../compiler/compile-ir-dag';
import { runPlanToDag } from '../compiler/run-plan-to-dag';
import type { WorkflowIR } from '../ir/models';
import type { DagPlan } from './dag-plan';
import type { RunPlan } from './run-plan';

/**
 * The single named seam producing an executable `DagPlan`, so every entry point names ONE producer
 * instead of reaching into `src/compiler` itself.
 */
@Injectable()
export class RuntimeCompiler {
  /** Lower a versioned `WorkflowIR`; `workflowId` arms the self-reference guard. */
  compile(ir: WorkflowIR, workflowId?: string): DagPlan {
    return compileWorkflowIrDag(ir, workflowId);
  }

  /** Lower a raw, client-supplied nested-tree `RunPlan`, preserving that API. */
  fromRunPlan(plan: RunPlan): DagPlan {
    return runPlanToDag(plan);
  }
}
