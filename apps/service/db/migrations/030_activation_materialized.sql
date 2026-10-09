-- 030 — an activation records what it actually stood up, apart from the desired trigger on its row.
-- Existing rows get NULL ("not known"), so the reconciler stands each of them up once more after this upgrade.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_trigger_activations ADD COLUMN IF NOT EXISTS materialized jsonb;
