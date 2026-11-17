-- 050 — a workflow its owner made in no workspace moves into their personal workspace (constitution row 22), where every session of theirs acts since 044:
-- its name-only pointers link to that workspace's environments of the same name, and one under a name the workspace lacks is dropped (row 7); its
-- signing secret kept for no environment goes to each of those environments in one statement; its runs count there. Each change is a WARNING, and a
-- workflow with no owner stays. Idempotent: once moved a workflow is in a workspace, so a re-run finds none, locks nothing and changes nothing.

DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflows w JOIN public.organizations o ON o.personal_owner_id = w.user_id WHERE w.org_id IS NULL) THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE moved (workflow_id uuid PRIMARY KEY, org_id uuid NOT NULL, name text NOT NULL) ON COMMIT DROP;

  FOR r IN
    UPDATE public.workflows w SET org_id = o.id
      FROM public.organizations o, public.users u
     WHERE o.personal_owner_id = w.user_id AND u.id = w.user_id AND w.org_id IS NULL
    RETURNING w.id, w.name, o.id AS org_id, u.email,
              (SELECT count(*) FROM public.runtime_runs x
                WHERE x.workflow_id = w.id AND x.org_id IS NULL AND x.parent_run_id IS NULL
                  AND x.status IN ('running', 'waiting')) AS unfinished
  LOOP
    INSERT INTO moved VALUES (r.id, r.org_id, r.name);
    RAISE WARNING '050 moved workflow % (%) of % into their personal workspace %, with its % unfinished run(s): it is on their dashboard there, and Run, an async start and Test this branch reach it',
      r.name, r.id, r.email, r.org_id, r.unfinished;
  END LOOP;

  -- Row 11: every write of an environment's pointers takes that environment's row first.
  PERFORM 1 FROM public.environments e WHERE e.org_id IN (SELECT org_id FROM moved) ORDER BY e.id FOR SHARE;

  FOR r IN
    UPDATE public.workflow_env_pointers p SET environment_id = e.id, environment = e.name
      FROM moved m, public.environments e
     WHERE p.workflow_id = m.workflow_id AND p.environment_id IS NULL
       AND e.org_id = m.org_id AND lower(e.name) = lower(p.environment)
    RETURNING m.name, m.workflow_id, m.org_id, e.name AS environment,
              (SELECT COALESCE(string_agg(c.app, ', ' ORDER BY c.app), 'none')
                 FROM public.environment_connections c WHERE c.environment_id = e.id) AS assigned
  LOOP
    RAISE WARNING '050 linked workflow % (%) to environment % of workspace %: each trigger its version there holds starts as the service starts, one that listens as an app''s account once the account assigned to that app there serves it, and a run started there takes that environment''s accounts (assigned: %), an app with none answering 428 until one is assigned',
      r.name, r.workflow_id, r.environment, r.org_id, r.assigned;
  END LOOP;

  FOR r IN
    DELETE FROM public.workflow_env_pointers p USING moved m
     WHERE p.workflow_id = m.workflow_id AND p.environment_id IS NULL
    RETURNING m.name, m.workflow_id, m.org_id, p.environment, p.version_id,
              (SELECT format('v%s%s', v.version_number, ' on ' || b.name)
                 FROM public.workflow_versions v LEFT JOIN public.workflow_branches b ON b.id = v.branch_id
                WHERE v.id = p.version_id) AS version
  LOOP
    RAISE WARNING '050 dropped the % pointer of workflow % (%) at version % (%): workspace % has no environment of that name, so its webhook and chat URLs under it answer 404; promote that version to an environment it has, or create one, to serve it there',
      r.environment, r.name, r.workflow_id, r.version_id, r.version, r.org_id;
  END LOOP;

  FOR r IN
    WITH gone AS (
      DELETE FROM public.webhook_trigger_secrets s USING moved m
       WHERE s.workflow_id = m.workflow_id AND s.environment_id IS NULL
      RETURNING s.workflow_id, s.node_id, s.secret, s.created_at, s.updated_at, m.org_id, m.name
    ), copied AS (
      INSERT INTO public.webhook_trigger_secrets (workflow_id, environment_id, node_id, secret, created_at, updated_at)
      SELECT g.workflow_id, e.id, g.node_id, g.secret, g.created_at, g.updated_at
        FROM gone g JOIN public.environments e ON e.org_id = g.org_id
      ON CONFLICT (workflow_id, COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'::uuid), node_id) DO NOTHING
      RETURNING workflow_id, node_id, environment_id
    )
    SELECT g.name, g.workflow_id, g.node_id, g.org_id,
           (SELECT COALESCE(string_agg(e.name, ', ' ORDER BY e.name), 'none')
              FROM copied c JOIN public.environments e ON e.id = c.environment_id
             WHERE c.workflow_id = g.workflow_id AND c.node_id = g.node_id) AS environments
      FROM gone g
  LOOP
    RAISE WARNING '050 gave the signing secret of trigger % in workflow % (%), which named no environment, to each environment of workspace % without its own (%): a delivery there is checked against it wherever that trigger has Verify signatures on',
      r.node_id, r.name, r.workflow_id, r.org_id, r.environments;
  END LOOP;

  UPDATE public.runtime_runs x SET org_id = m.org_id FROM moved m WHERE x.workflow_id = m.workflow_id AND x.org_id IS NULL;

  FOR r IN
    SELECT m.name, m.workflow_id, o.name AS caller_name, o.id AS caller, count(*) AS calls
      FROM public.runtime_runs x
      JOIN moved m ON m.workflow_id = x.workflow_id
      -- The caller is the workspace its call tree started in, as the call rule judges it, whatever this boot stamped on the runs between.
      LEFT JOIN LATERAL (
        WITH RECURSIVE up AS (
          SELECT a.parent_run_id, a.org_id, 1 AS depth FROM public.runtime_runs a WHERE a.id = x.parent_run_id
          UNION ALL
          SELECT b.parent_run_id, b.org_id, up.depth + 1
            FROM public.runtime_runs b JOIN up ON b.id = up.parent_run_id
           WHERE up.depth < 64
        )
        SELECT up.org_id FROM up ORDER BY up.depth DESC LIMIT 1
      ) root ON true
      JOIN public.organizations o ON o.id = COALESCE(root.org_id, x.org_id)
     WHERE x.parent_run_id IS NOT NULL AND o.id <> m.org_id
     GROUP BY m.name, m.workflow_id, o.name, o.id
     ORDER BY m.workflow_id, o.id
  LOOP
    RAISE WARNING '050 moved workflow % (%) out of reach of workspace % (%), whose runs called it % time(s): a workflow calls only workflows in its own workspace, so a call from there is refused as not found from now on',
      r.name, r.workflow_id, r.caller_name, r.caller, r.calls;
  END LOOP;
END $$;
