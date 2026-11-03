-- 046 — an API key acts only in the one org it is issued for (constitution row 24): each key an earlier release left unpinned (org_id NULL)
-- is pinned to its owner's personal workspace, which 044 has just given every account, and org_id becomes NOT NULL. A live key it pins is a
-- WARNING; a revoked or expired one, which acts nowhere, is pinned silently. Idempotent: once org_id is NOT NULL, a re-run takes no lock and
-- changes nothing; every release since v0.1.0 pins a new key to its holder's personal workspace, so going back never needs a NULL.

DO $$
DECLARE
  r record;
BEGIN
  IF (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.api_keys'::regclass AND attname = 'org_id') THEN
    RETURN;
  END IF;
  LOCK TABLE public.api_keys IN ACCESS EXCLUSIVE MODE;

  FOR r IN
    UPDATE public.api_keys k SET org_id = o.id
      FROM public.organizations o, public.users u
     WHERE o.personal_owner_id = k.user_id AND u.id = k.user_id AND k.org_id IS NULL
    RETURNING k.id, k.name, k.prefix, u.email, o.id AS org_id,
              k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at >= now()) AS live
  LOOP
    IF r.live THEN
      RAISE WARNING '046 pinned API key % (%, %…) of % to their personal workspace %: it reached every organization they belong to, and now acts only there',
        r.name, r.id, r.prefix, r.email, r.org_id;
    END IF;
  END LOOP;

  ALTER TABLE public.api_keys ALTER COLUMN org_id SET NOT NULL;
END $$;
