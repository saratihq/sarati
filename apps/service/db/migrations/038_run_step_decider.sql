-- 038 — who answered a wait lives on the step it answered: one slot on the run kept only the last decider.
-- The slot's time comes from another clock than a step's (v0.2.23 stamped the app's), so no time places it: a
-- decision is copied onto a step only when its run has exactly one wait that could have taken it, and every
-- other stays on the slot, which is kept, and still written, for an older image.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_run_steps ADD COLUMN IF NOT EXISTS decided_by uuid;
ALTER TABLE runtime_run_steps ADD COLUMN IF NOT EXISTS decided_at timestamptz;

WITH answerable AS (
  SELECT s.run_id, min(s.step_key) AS step_key, count(*) AS candidates
    FROM runtime_run_steps s
    JOIN runtime_runs r ON r.id = s.run_id
   WHERE r.decided_by IS NOT NULL
     AND s.kind = 'waitForEvent'
     AND NOT s.pinned
     AND s.decided_by IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM runtime_run_steps d WHERE d.run_id = r.id AND d.decided_by = r.decided_by
          AND d.decided_at = r.decided_at
     )
   GROUP BY s.run_id
)
UPDATE runtime_run_steps s
   SET decided_by = r.decided_by, decided_at = r.decided_at
  FROM runtime_runs r
  JOIN answerable a ON a.run_id = r.id
 WHERE s.run_id = r.id
   AND s.step_key = a.step_key
   AND a.candidates = 1;
