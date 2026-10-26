-- 042 — an org's default environments are created with it, not by a list, so an org an earlier version never listed gets them here.
-- One it listed holds production and uat, which are never renamed or deleted (constitution row 7), so a staging it lacks was removed and stays so.
-- Idempotent: db:migrate re-runs every file, and only an org without environments_seeded_at is seeded.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS environments_seeded_at timestamp with time zone;

INSERT INTO environments (org_id, name, is_prod)
SELECT o.id, d.name, d.name = 'production'
  FROM organizations o
 CROSS JOIN unnest(ARRAY['production', 'staging', 'uat']) AS d(name)
 WHERE o.environments_seeded_at IS NULL
   AND NOT (
     EXISTS (SELECT 1 FROM environments e WHERE e.org_id = o.id AND lower(e.name) = 'production')
     AND EXISTS (SELECT 1 FROM environments e WHERE e.org_id = o.id AND lower(e.name) = 'uat')
   )
ON CONFLICT (org_id, lower(name)) DO NOTHING;

UPDATE organizations SET environments_seeded_at = now() WHERE environments_seeded_at IS NULL;
