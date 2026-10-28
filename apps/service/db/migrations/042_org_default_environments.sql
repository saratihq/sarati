-- 042 — an org's default environments are created with it, not by a list, so an org an earlier version created gets each one it never had here.
-- production and uat are never renamed or deleted (constitution row 7), so one it lacks it never had; a staging it lacks it never had unless its events show staging deleted or renamed, which stays so.
-- Idempotent: db:migrate re-runs every file, and environments_seeded_at keeps a re-run off every org already considered, whatever row 7 or the events say later.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS environments_seeded_at timestamp with time zone;

INSERT INTO environments (org_id, name, is_prod)
SELECT o.id, d.name, d.name = 'production'
  FROM organizations o
 CROSS JOIN unnest(ARRAY['production', 'staging', 'uat']) AS d(name)
 WHERE o.environments_seeded_at IS NULL
   AND NOT (
     d.name = 'staging'
     AND EXISTS (
       SELECT 1 FROM domain_events ev
        WHERE ev.org_id = o.id
          AND ((ev.type = 'environment.deleted' AND lower(ev.payload->>'name') = 'staging')
            OR (ev.type = 'environment.renamed' AND lower(ev.payload->>'from') = 'staging'))
     )
   )
ON CONFLICT (org_id, lower(name)) DO NOTHING;

UPDATE organizations SET environments_seeded_at = now() WHERE environments_seeded_at IS NULL;
