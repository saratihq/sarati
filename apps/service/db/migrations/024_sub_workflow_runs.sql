-- 024 — a sub-workflow run is a run, recorded under the workflow that actually executed.
--
-- A workflow called by another (an agent's tool, or an authored call-workflow step)
-- ran with no record at all, so a failure inside it was invisible: the caller saw
-- only what the call returned. It now writes an ordinary row under its OWN
-- workflow_id, pointing back at the step that called it.
--
-- parent_step_key matches runtime_run_steps.step_key in the parent run, which is
-- what lets the two link in both directions.

ALTER TABLE public.runtime_runs
    ADD COLUMN IF NOT EXISTS parent_run_id varchar(200),
    ADD COLUMN IF NOT EXISTS parent_step_key varchar(500);

-- The parent's run detail resolves its children with this.
CREATE INDEX IF NOT EXISTS ix_runtime_runs_parent
    ON public.runtime_runs (parent_run_id)
    WHERE parent_run_id IS NOT NULL;
