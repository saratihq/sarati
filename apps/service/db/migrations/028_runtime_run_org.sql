-- 028 — every run remembers the org it ran in, so deleting its workflow cannot make it reachable again.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS org_id uuid;

UPDATE runtime_runs r
   SET org_id = w.org_id
  FROM workflows w
 WHERE r.org_id IS NULL
   AND r.workflow_id = w.id
   AND w.org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_runtime_runs_org ON runtime_runs (org_id) WHERE org_id IS NOT NULL;
