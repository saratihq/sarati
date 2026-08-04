-- 013 — retry-on-fail: count a step's provider calls.
--
-- A step with `retry:{maxAttempts,backoffMs}` retries INSIDE the one durable step.
-- This records how many attempts it took — 1 for the ordinary single call — so run
-- history can say "succeeded on attempt 3" / "failed after 3 attempts".
--
-- The policy itself is orchestration metadata on the version doc's node
-- (`parameters.retry`, compiler-lowered + clamped, stripped from provider props).

ALTER TABLE public.runtime_run_steps
    ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 1 NOT NULL;
