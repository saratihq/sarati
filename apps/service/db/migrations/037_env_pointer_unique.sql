-- 037 — one pointer per (workflow, environment): a promote that raced a rename could leave a second row under the old name.
-- Keeps the row under the environment's current name, else the newest, and reports each row it drops.
-- Idempotent: db:migrate re-runs every file.

DO $$
DECLARE
  dropped RECORD;
BEGIN
  FOR dropped IN
    DELETE FROM workflow_env_pointers p
     USING (
       SELECT q.workflow_id,
              q.environment,
              row_number() OVER (
                PARTITION BY q.workflow_id, q.environment_id
                ORDER BY (q.environment = e.name) DESC, q.updated_at DESC, q.environment
              ) AS rank
         FROM workflow_env_pointers q
         JOIN environments e ON e.id = q.environment_id
     ) ranked
     WHERE ranked.workflow_id = p.workflow_id
       AND ranked.environment = p.environment
       AND ranked.rank > 1
    RETURNING p.workflow_id, p.environment, p.environment_id, p.version_id
  LOOP
    RAISE WARNING '037 removed a duplicate pointer: workflow %, environment % (as %), version %',
      dropped.workflow_id, dropped.environment_id, dropped.environment, dropped.version_id;
  END LOOP;
END $$;

UPDATE workflow_env_pointers p
   SET environment = e.name
  FROM environments e
 WHERE e.id = p.environment_id
   AND p.environment <> e.name
   AND NOT EXISTS (
     SELECT 1 FROM workflow_env_pointers q
      WHERE q.workflow_id = p.workflow_id AND q.environment = e.name
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_env_pointers_workflow_env
    ON public.workflow_env_pointers USING btree (workflow_id, environment_id)
 WHERE (environment_id IS NOT NULL);
