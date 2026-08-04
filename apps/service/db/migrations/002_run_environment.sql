-- 002 — persist a run's environment.

ALTER TABLE public.runtime_runs
    ADD COLUMN IF NOT EXISTS environment character varying(100);
