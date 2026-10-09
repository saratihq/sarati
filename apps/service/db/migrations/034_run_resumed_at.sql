-- 034 — a run records when it last resumed from a wait, so the maximum duration bounds a stretch in flight, not its whole life.
-- Idempotent: db:migrate re-runs every file. The backfill converges on every boot, so a run an older image resumed takes the end of its last parked wait.

ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS resumed_at timestamptz;

UPDATE runtime_runs r
   SET resumed_at = w.wait_ended_at
  FROM (SELECT s.run_id, max(s.finished_at) AS wait_ended_at
          FROM runtime_run_steps s
          JOIN runtime_runs rr ON rr.id = s.run_id AND rr.status = 'running' AND NOT rr.dry_run
         WHERE s.finished_at IS NOT NULL
           AND (s.kind = 'waitForEvent' OR (s.kind = 'delay' AND s.output::jsonb ? 'slept_until'))
         GROUP BY s.run_id) w
 WHERE r.id = w.run_id
   AND (r.resumed_at IS NULL OR r.resumed_at < w.wait_ended_at);
