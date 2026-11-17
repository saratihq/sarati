-- 049 — a webhook signing secret set with no environment named, on a workflow in a workspace, was kept for no environment, which that workflow's intake never
-- reads; it is production's now, as such a secret is from now on. Each moves to production with a WARNING, or goes with one where
-- production already has its own for that trigger. A workflow in no workspace keeps its one env-less secret. Idempotent: a re-run finds none and takes no lock.

DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.webhook_trigger_secrets s JOIN public.workflows w ON w.id = s.workflow_id
                  WHERE s.environment_id IS NULL AND w.org_id IS NOT NULL) THEN
    RETURN;
  END IF;
  LOCK TABLE public.webhook_trigger_secrets IN SHARE ROW EXCLUSIVE MODE;

  FOR r IN
    DELETE FROM public.webhook_trigger_secrets s
     USING public.workflows w, public.environments e
     WHERE s.environment_id IS NULL AND w.id = s.workflow_id AND e.org_id = w.org_id AND lower(e.name) = 'production'
       AND EXISTS (SELECT 1 FROM public.webhook_trigger_secrets p
                    WHERE p.workflow_id = s.workflow_id AND p.environment_id = e.id AND p.node_id = s.node_id)
    RETURNING s.workflow_id, s.node_id, e.id AS environment_id
  LOOP
    RAISE WARNING '049 deleted the signing secret of trigger % in workflow % that named no environment: its production environment % has its own, the one deliveries there are checked against',
      r.node_id, r.workflow_id, r.environment_id;
  END LOOP;

  FOR r IN
    UPDATE public.webhook_trigger_secrets s SET environment_id = e.id, updated_at = now()
      FROM public.workflows w, public.environments e
     WHERE s.environment_id IS NULL AND w.id = s.workflow_id AND e.org_id = w.org_id AND lower(e.name) = 'production'
    RETURNING s.workflow_id, s.node_id, e.id AS environment_id
  LOOP
    RAISE WARNING '049 gave the signing secret of trigger % in workflow %, which named no environment, to its production environment %: a delivery there is checked against it wherever that trigger has Verify signatures on',
      r.node_id, r.workflow_id, r.environment_id;
  END LOOP;
END $$;
