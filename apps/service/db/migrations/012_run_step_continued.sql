-- 012 — continue-on-fail: mark TOLERATED errored run steps.
--
-- A step with `onError:"continue"` that throws is recorded errored but the run
-- goes ON. This column distinguishes "errored, run continued" from a hard halt, so
-- the runs panel can say so rather than imply the workflow died.
--
-- The policy itself is orchestration metadata on the version doc's node
-- (`parameters.onError`, compiler-lowered and stripped from provider props).

ALTER TABLE public.runtime_run_steps
    ADD COLUMN IF NOT EXISTS continued boolean DEFAULT false NOT NULL;
