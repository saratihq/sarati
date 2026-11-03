-- 048 — a run's budget: the per-run limits it was admitted under (`limits`, NULL for a run admitted before them, which runs
-- unlimited and is never stopped for its time), the steps its tree has taken (`steps_used`, charged on the root's row) and
-- when its tree last came back from waiting (`active_since`, NULL until then: its time in flight counts from its start);
-- one partial index serves admission's count of a workspace's unfinished top-level runs, the other each run's open steps.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE public.runtime_runs ADD COLUMN IF NOT EXISTS limits json;
ALTER TABLE public.runtime_runs ADD COLUMN IF NOT EXISTS steps_used integer DEFAULT 0 NOT NULL;
ALTER TABLE public.runtime_runs ADD COLUMN IF NOT EXISTS active_since timestamp with time zone;

CREATE INDEX IF NOT EXISTS ix_runtime_runs_workspace_unfinished ON public.runtime_runs USING btree (org_id, user_id)
    WHERE parent_run_id IS NULL AND status IN ('running', 'waiting');
CREATE INDEX IF NOT EXISTS ix_runtime_run_steps_open ON public.runtime_run_steps USING btree (run_id)
    WHERE finished_at IS NULL;
