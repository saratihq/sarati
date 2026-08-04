-- 016 — connections outbound foreign keys + orphan cleanup.
--
-- `connections` shipped with ZERO outbound FKs, and an orphan `org_id` is what
-- wedged 006's environments backfill (guarded there too). This adds the missing
-- FKs so orphans cannot recur — after clearing any that already exist, since ADD
-- CONSTRAINT would otherwise fail on the bad rows.

-- ── Orphan cleanup (must run BEFORE the ADD CONSTRAINTs below) ──
-- An org-scoped connection whose org is gone reverts to the owner's personal pool
-- (org_id NULL) — non-destructive, and consistent with the SET NULL rule added below.
UPDATE public.connections c
   SET org_id = NULL
 WHERE c.org_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c.org_id);

-- A connection whose owning user is gone is unusable and unreachable — remove it
-- (the CASCADE below would do the same on a future user delete).
DELETE FROM public.connections c
 WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = c.user_id);

-- ── The FKs (ADD CONSTRAINT has no IF NOT EXISTS — guard the re-apply) ──
-- user_id is NOT NULL and is the owner: deleting the user removes their connections.
DO $$
BEGIN
    ALTER TABLE public.connections
        ADD CONSTRAINT connections_user_id_fkey FOREIGN KEY (user_id)
            REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- org_id is nullable (Default-pool connections have none): deleting the org reverts
-- its connections to the owner's personal pool rather than destroying them.
DO $$
BEGIN
    ALTER TABLE public.connections
        ADD CONSTRAINT connections_org_id_fkey FOREIGN KEY (org_id)
            REFERENCES public.organizations(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
