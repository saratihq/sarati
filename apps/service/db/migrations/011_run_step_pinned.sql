-- 011 — mark REPLAYED run steps.
--
-- A pinned step replays its captured sample instead of executing: no provider
-- call, no side effect. This column keeps run history honest about which steps
-- really ran, so the runs panel can label a replay rather than imply a real call.
--
-- Pins themselves are EPHEMERAL — they ride the run request only and never enter
-- the workflow document, so they touch no invariant-vault row.

ALTER TABLE public.runtime_run_steps
    ADD COLUMN IF NOT EXISTS pinned boolean DEFAULT false NOT NULL;
