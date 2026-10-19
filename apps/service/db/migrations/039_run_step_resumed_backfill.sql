-- 039 — the reaper counts a run's time in flight from its latest wait to end, so a wait an older image resumed takes its step's end.
-- Idempotent: db:migrate re-runs every file, and it only fills a missing end, on a run still live.

UPDATE runtime_run_steps s
   SET resumed_at = s.finished_at
  FROM runtime_runs r
 WHERE r.id = s.run_id AND r.status IN ('running', 'waiting') AND NOT r.dry_run
   AND s.resumed_at IS NULL AND s.finished_at IS NOT NULL
   AND (s.kind = 'waitForEvent' OR (s.kind = 'delay' AND s.output->>'slept_until' IS NOT NULL));

CREATE INDEX IF NOT EXISTS ix_runtime_run_steps_resumed ON runtime_run_steps (run_id, resumed_at) WHERE resumed_at IS NOT NULL;
