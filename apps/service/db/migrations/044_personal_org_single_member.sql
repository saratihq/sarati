-- 044 — a personal workspace has exactly one member, its owner (organizations.personal_owner_id), which the database holds it to; a membership an
-- earlier release inserts into the personal workspace it has just made claims it, so that release still makes accounts on this schema.
-- Each existing one keeps only its owner, taken from records no invited member can write; the rest go, each with a WARNING, and one with no such owner,
-- or an account's second, becomes a shared organization. Idempotent: db:migrate re-runs every file, and every step changes only a row that breaks the rule.

-- The admission lock first, so no admission holds a user or org row, then each table at full strength, organizations first (constitution row 20).
SELECT pg_advisory_xact_lock(7302, 0);
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS personal_owner_id uuid;
ALTER TABLE public.org_members ADD COLUMN IF NOT EXISTS is_personal boolean DEFAULT false NOT NULL;
LOCK TABLE public.users, public.org_invites, public.api_keys, public.environment_connections IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  r record;
  org uuid;
BEGIN
  CREATE TEMP TABLE personal_owner ON COMMIT DROP AS
  SELECT o.id AS org_id,
         COALESCE(
           o.personal_owner_id,
           (SELECT u.id
              FROM (SELECT ev.actor_user_id FROM public.domain_events ev
                     WHERE ev.org_id = o.id AND ev.type = 'user.provisioned'
                     ORDER BY ev.created_at, ev.id LIMIT 1) provisioned
              JOIN public.users u ON u.id = provisioned.actor_user_id),
           (SELECT u.id
              FROM (SELECT i.created_by FROM public.org_invites i
                     WHERE i.org_id = o.id AND i.accepted_at IS NOT NULL
                     ORDER BY i.created_by IS NULL
                                OR EXISTS (SELECT 1 FROM public.org_invites j WHERE j.org_id = o.id AND j.accepted_by = i.created_by),
                              i.accepted_at, i.created_at, i.id
                     LIMIT 1) inviter
              JOIN public.users u ON u.id = inviter.created_by),
           (SELECT m.user_id FROM public.org_members m
             WHERE m.org_id = o.id
               AND NOT EXISTS (SELECT 1 FROM public.org_invites i WHERE i.org_id = o.id AND i.accepted_by = m.user_id)
             ORDER BY m.created_at, m.user_id LIMIT 1)
         ) AS owner_id
    FROM public.organizations o
   WHERE o.is_personal;

  UPDATE personal_owner p SET owner_id = NULL
    FROM (SELECT q.org_id,
                 row_number() OVER (PARTITION BY q.owner_id
                                    ORDER BY (o.personal_owner_id IS NOT NULL) DESC, o.created_at, o.id) AS rank
            FROM personal_owner q JOIN public.organizations o ON o.id = q.org_id
           WHERE q.owner_id IS NOT NULL) ranked
   WHERE ranked.org_id = p.org_id AND ranked.rank > 1;

  FOR r IN
    UPDATE public.organizations o SET is_personal = false, updated_at = now()
      FROM personal_owner p
     WHERE p.org_id = o.id AND p.owner_id IS NULL
    RETURNING o.id, o.name
  LOOP
    RAISE WARNING '044 made personal workspace % (%) a shared organization, keeping its members: no account can be shown to own it, or its account owns an older one',
      r.name, r.id;
  END LOOP;

  FOR r IN
    UPDATE public.api_keys k SET revoked_at = now()
      FROM public.users u, personal_owner p
     WHERE u.id = k.user_id AND p.org_id = k.org_id AND p.owner_id IS NULL AND k.revoked_at IS NULL
    RETURNING k.id, k.name, k.prefix, k.org_id, u.email
  LOOP
    RAISE WARNING '044 revoked API key % (%, %…) of %, pinned to workspace % that is now a shared organization',
      r.name, r.id, r.prefix, r.email, r.org_id;
  END LOOP;
  DELETE FROM personal_owner WHERE owner_id IS NULL;

  FOR r IN
    DELETE FROM public.environment_connections ec
     USING public.environments e, public.connections c, public.users u, personal_owner p
     WHERE e.id = ec.environment_id AND c.id = ec.connection_id AND u.id = c.user_id
       AND p.org_id = e.org_id AND c.user_id <> p.owner_id
    RETURNING e.org_id, e.name AS environment, ec.app, c.id AS connection_id, u.email
  LOOP
    RAISE WARNING '044 emptied the % slot of environment % in personal workspace %: it held connection % of %, who does not own the workspace',
      r.app, r.environment, r.org_id, r.connection_id, r.email;
  END LOOP;

  FOR r IN
    UPDATE public.api_keys k SET revoked_at = now()
      FROM public.users u, personal_owner p
     WHERE u.id = k.user_id AND p.org_id = k.org_id AND k.user_id <> p.owner_id AND k.revoked_at IS NULL
    RETURNING k.id, k.name, k.prefix, k.org_id, u.email
  LOOP
    RAISE WARNING '044 revoked API key % (%, %…) of %, pinned to personal workspace % it does not own',
      r.name, r.id, r.prefix, r.email, r.org_id;
  END LOOP;

  FOR r IN
    DELETE FROM public.org_invites i USING personal_owner p
     WHERE i.org_id = p.org_id AND i.accepted_at IS NULL
    RETURNING i.org_id, i.email, i.role
  LOOP
    RAISE WARNING '044 deleted the pending invite of % as % into personal workspace %', r.email, r.role, r.org_id;
  END LOOP;

  FOR r IN
    DELETE FROM public.org_members m USING public.users u, personal_owner p
     WHERE u.id = m.user_id AND p.org_id = m.org_id AND m.user_id <> p.owner_id
    RETURNING m.org_id, m.user_id, m.role, u.email,
              (SELECT count(*) FROM public.workflows w WHERE w.org_id = m.org_id AND w.user_id = m.user_id) AS workflows
  LOOP
    RAISE WARNING '044 removed % (%), a member as %, from personal workspace %, which it does not own; the % workflow(s) it created there stay in it',
      r.email, r.user_id, r.role, r.org_id, r.workflows;
  END LOOP;

  FOR r IN
    UPDATE public.org_members m SET role = 'owner'
      FROM public.users u, personal_owner p
     WHERE u.id = m.user_id AND m.org_id = p.org_id AND m.user_id = p.owner_id AND m.role <> 'owner'
    RETURNING m.org_id, m.user_id, u.email
  LOOP
    RAISE WARNING '044 gave % (%) back the owner role in their personal workspace %', r.email, r.user_id, r.org_id;
  END LOOP;

  FOR r IN
    INSERT INTO public.org_members (id, org_id, user_id, role, is_personal, created_at)
    SELECT gen_random_uuid(), p.org_id, p.owner_id, 'owner', true, now() FROM personal_owner p
     WHERE NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = p.org_id AND m.user_id = p.owner_id)
    RETURNING org_id, user_id, (SELECT u.email FROM public.users u WHERE u.id = user_id) AS email
  LOOP
    RAISE WARNING '044 added % (%) back to their personal workspace %, as its owner', r.email, r.user_id, r.org_id;
  END LOOP;

  UPDATE public.organizations o SET personal_owner_id = p.owner_id
    FROM personal_owner p
   WHERE o.id = p.org_id AND o.personal_owner_id IS NULL;

  UPDATE public.org_members m SET is_personal = true
    FROM personal_owner p
   WHERE m.org_id = p.org_id AND NOT m.is_personal;

  FOR r IN
    SELECT u.id, u.name, u.email FROM public.users u
     WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_id = u.id)
     ORDER BY u.id
  LOOP
    org := gen_random_uuid();
    INSERT INTO public.organizations (id, name, is_personal, personal_owner_id, created_at, updated_at, environments_seeded_at)
    VALUES (org, r.name, true, r.id, now(), now(), now());
    INSERT INTO public.org_members (id, org_id, user_id, role, is_personal, created_at)
    VALUES (gen_random_uuid(), org, r.id, 'owner', true, now());
    INSERT INTO public.environments (org_id, name, is_prod)
    SELECT org, name, name = 'production' FROM unnest(ARRAY['production', 'staging', 'uat']) AS name;
    RAISE WARNING '044 gave % (%) a personal workspace of its own, %: it had none', r.email, r.id, org;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.check_personal_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations o
              WHERE o.id = NEW.id AND o.is_personal <> (o.personal_owner_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'organization % violates organizations_personal_owner_check: an organization names an owner exactly when it is personal', NEW.id
      USING ERRCODE = 'check_violation', TABLE = 'organizations', CONSTRAINT = 'organizations_personal_owner_check';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_personal_org() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public.organizations SET personal_owner_id = NEW.user_id
   WHERE id = NEW.org_id AND is_personal AND personal_owner_id IS NULL;
  NEW.is_personal := FOUND;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_personal_owner_id_fkey') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_personal_owner_id_fkey
      FOREIGN KEY (personal_owner_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_personal_owner_id_key') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_personal_owner_id_key UNIQUE (personal_owner_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_personal_owner_check') THEN
    CREATE CONSTRAINT TRIGGER organizations_personal_owner_check
      AFTER INSERT OR UPDATE OF id, is_personal, personal_owner_id ON public.organizations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_personal_owner();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_id_is_personal_key') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_id_is_personal_key UNIQUE (id, is_personal);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_org_id_is_personal_fkey') THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_org_id_is_personal_fkey
      FOREIGN KEY (org_id, is_personal) REFERENCES public.organizations(id, is_personal) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_personal_role_check') THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_personal_role_check
      CHECK (NOT is_personal OR role = 'owner');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_personal_owner_member_fkey') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_personal_owner_member_fkey
      FOREIGN KEY (id, personal_owner_id) REFERENCES public.org_members(org_id, user_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'org_members_claim_personal_org' AND tgrelid = 'public.org_members'::regclass) THEN
    CREATE TRIGGER org_members_claim_personal_org BEFORE INSERT ON public.org_members
      FOR EACH ROW WHEN (NOT NEW.is_personal) EXECUTE FUNCTION public.claim_personal_org();
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_org_members_personal_org ON public.org_members USING btree (org_id) WHERE is_personal;
