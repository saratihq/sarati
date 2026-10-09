-- 033 — a wait lives on the step that parked it. The run's old slot stays, kept in step by the
-- service, so an older image still starts and answers. Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_run_steps ADD COLUMN IF NOT EXISTS waiting_topic varchar(200);
ALTER TABLE runtime_run_steps ADD COLUMN IF NOT EXISTS waiting_since timestamptz;
ALTER TABLE runtime_run_steps ADD COLUMN IF NOT EXISTS waiting_timeout_at timestamptz;
ALTER TABLE runtime_run_steps ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- A wait no live step can hold any more — one an older image ended — is cleared before anything reads it.
UPDATE runtime_run_steps s
   SET waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL, claimed_at = NULL
 WHERE s.waiting_topic IS NOT NULL
   AND (s.status <> 'running'
        OR NOT EXISTS (SELECT 1 FROM runtime_runs r WHERE r.id = s.run_id AND r.status IN ('running', 'waiting')));

-- A wait an older image parked in the slot moves onto its step, unless a step already holds it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'runtime_runs' AND column_name = 'waiting_topic') THEN
    EXECUTE $sql$
      UPDATE runtime_run_steps s
         SET waiting_topic = r.waiting_topic,
             waiting_since = COALESCE(r.waiting_since, s.started_at),
             waiting_timeout_at = r.waiting_timeout_at
        FROM runtime_runs r
       WHERE s.run_id = r.id
         AND r.status = 'waiting'
         AND r.waiting_topic IS NOT NULL
         AND s.status = 'running'
         AND s.finished_at IS NULL
         AND s.waiting_topic IS NULL
         AND CASE WHEN r.waiting_topic LIKE 'orchestr:timer:%'
                  THEN s.kind = 'delay' AND s.step_key = substr(r.waiting_topic, 16)
                  ELSE s.kind = 'waitForEvent' AND s.node_id = r.waiting_node_id END
         AND NOT EXISTS (SELECT 1 FROM runtime_run_steps p
                          WHERE p.run_id = r.id AND p.waiting_topic = r.waiting_topic)
    $sql$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_runtime_run_steps_waiting ON runtime_run_steps (run_id) WHERE waiting_topic IS NOT NULL;
