/** The legacy engine's DBOS workflow name; a persisted identifier in `dbos.workflow_status` of every run it has in flight. */
export const RUN_PLAN_WORKFLOW = 'orchestr.runPlan';

/** The sequenced engine's DBOS workflow name, which every new run starts on; a persisted identifier too. */
export const RUN_PLAN_V2_WORKFLOW = 'orchestr.runPlan.v2';

/** Both engines' workflow names: a run in flight under either is one this service resumes. */
export const RUN_PLAN_WORKFLOWS: ReadonlySet<string> = new Set([RUN_PLAN_WORKFLOW, RUN_PLAN_V2_WORKFLOW]);
