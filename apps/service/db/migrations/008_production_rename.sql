-- 008 — 'prod' → 'production'. The is_prod FLAG stays the anchor; this renames the
-- label everywhere it is stored as a string.
--
-- CONVERGENT, not merely idempotent: 005/006 re-run first and can resurrect a
-- 'prod' env + pointer alongside the 'production' this file already created. So
-- before renaming it MERGES any duplicate 'prod' env into the org's 'production'
-- env, re-pointing every reference first — the env FKs CASCADE/SET NULL, so a bare
-- delete would lose data — and every rename below is collision-safe.

-- ── Converge: fold a duplicate 'prod' env into the org's 'production' env ──
DO $$
DECLARE
  m RECORD;
  has_activations boolean := to_regclass('public.runtime_trigger_activations') IS NOT NULL;
  -- `runtime_triggers` is dropped by 014; guard its re-point so the re-run stays
  -- a no-op once it is gone.
  has_triggers boolean := to_regclass('public.runtime_triggers') IS NOT NULL;
BEGIN
  FOR m IN
    SELECT dup.id AS prod_id, keep.id AS production_id
      FROM environments dup
      JOIN environments keep
        ON keep.org_id = dup.org_id
       AND lower(keep.name) = 'production'
       AND keep.id <> dup.id
     WHERE lower(dup.name) = 'prod'
  LOOP
    -- pointers: PK (workflow_id, environment) — drop a colliding duplicate, else move.
    DELETE FROM workflow_env_pointers p
     WHERE p.environment_id = m.prod_id
       AND EXISTS (
         SELECT 1 FROM workflow_env_pointers q
          WHERE q.workflow_id = p.workflow_id AND q.environment_id = m.production_id
       );
    UPDATE workflow_env_pointers
       SET environment_id = m.production_id, environment = 'production'
     WHERE environment_id = m.prod_id;

    -- triggers: re-point (PK is id — no collision).
    IF has_triggers THEN
      UPDATE runtime_triggers
         SET environment_id = m.production_id, environment = 'production'
       WHERE environment_id = m.prod_id;
    END IF;

    -- slots: PK (environment_id, app) — drop a colliding duplicate, else move.
    DELETE FROM environment_connections ec
     WHERE ec.environment_id = m.prod_id
       AND EXISTS (
         SELECT 1 FROM environment_connections f
          WHERE f.environment_id = m.production_id AND f.app = ec.app
       );
    UPDATE environment_connections
       SET environment_id = m.production_id
     WHERE environment_id = m.prod_id;

    -- runs: history — re-point the id so it stays truthful (name snapshot is kept).
    UPDATE runtime_runs SET environment_id = m.production_id WHERE environment_id = m.prod_id;

    -- activations (present only after 009): UNIQUE (workflow, env, node) — drop a
    -- colliding duplicate, else move; the env FK is CASCADE, so this must precede the delete.
    IF has_activations THEN
      DELETE FROM runtime_trigger_activations a
       WHERE a.environment_id = m.prod_id
         AND EXISTS (
           SELECT 1 FROM runtime_trigger_activations b
            WHERE b.workflow_id = a.workflow_id
              AND b.environment_id = m.production_id
              AND b.trigger_node_id = a.trigger_node_id
         );
      UPDATE runtime_trigger_activations
         SET environment_id = m.production_id
       WHERE environment_id = m.prod_id;
    END IF;

    DELETE FROM environments WHERE id = m.prod_id;
  END LOOP;
END $$;

-- ── Rename a LONE 'prod' env (no 'production' sibling left) to 'production' ──
UPDATE environments e
   SET name = 'production'
 WHERE e.is_prod
   AND lower(e.name) = 'prod'
   AND NOT EXISTS (
     SELECT 1 FROM environments x
      WHERE x.org_id = e.org_id AND lower(x.name) = 'production' AND x.id <> e.id
   );

-- ── Pointer/trigger name strings follow, collision-safe. Run history is
--    untouched: environment there is a historical snapshot. ──
DELETE FROM workflow_env_pointers p
 WHERE lower(p.environment) = 'prod'
   AND EXISTS (
     SELECT 1 FROM workflow_env_pointers q
      WHERE q.workflow_id = p.workflow_id AND lower(q.environment) = 'production'
   );
UPDATE workflow_env_pointers SET environment = 'production' WHERE lower(environment) = 'prod';

DO $$
BEGIN
  IF to_regclass('public.runtime_triggers') IS NOT NULL THEN
    UPDATE runtime_triggers SET environment = 'production' WHERE lower(environment) = 'prod';
  END IF;
END $$;
