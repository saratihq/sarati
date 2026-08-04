-- 003 — env-scoped triggers.
--
-- A trigger may fire under an org environment: the fired run then carries
-- (environment, org) so the action router rebinds connection'd steps to that env's
-- org cluster and runs them as the cluster owner. NULL = personal/test.
--
-- `runtime_triggers` is dropped by 014; guard the alter so the re-run stays a
-- no-op once the table is gone.

DO $$
BEGIN
  IF to_regclass('public.runtime_triggers') IS NOT NULL THEN
    ALTER TABLE public.runtime_triggers
        ADD COLUMN IF NOT EXISTS environment character varying(100);
  END IF;
END $$;
