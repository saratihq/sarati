-- 018 — dry run (preview): a run that fires no state-changing external call (SDK
-- mutating HTTP stubbed, Composio typed execution skipped, delays/waits skipped).

ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false;
