-- 006 — environments as first-class rows.
--
-- One pool, curated named environments: connections stay in the per-user flat pool
-- ("Default" — NOT an environment, no row); named environments become org-scoped
-- rows with SLOTS (`environment_connections`: (env, app) → one pool connection, by
-- reference — assigning never mutates the connection row). Pointers and triggers
-- gain `environment_id`; reads prefer the id over the legacy name string. Runs
-- gain a nullable `environment_id` while KEEPING the name string as a historical
-- snapshot — runs are history and must survive env deletion/rename (FK SET NULL).
--
-- BACKFILL: every DISTINCT legacy environment string becomes an environments row
-- in its org, and legacy cluster connections become slot rows on the same
-- connection.

CREATE TABLE IF NOT EXISTS public.environments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    is_prod boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT environments_pkey PRIMARY KEY (id),
    CONSTRAINT environments_org_id_fkey FOREIGN KEY (org_id)
        REFERENCES public.organizations(id) ON DELETE CASCADE
);

-- Case-insensitive uniqueness: "Staging" and "staging" can never coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_org_lower_name
    ON public.environments (org_id, lower(name));

CREATE TABLE IF NOT EXISTS public.environment_connections (
    environment_id uuid NOT NULL,
    app text NOT NULL,
    connection_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT environment_connections_pkey PRIMARY KEY (environment_id, app),
    CONSTRAINT environment_connections_environment_id_fkey FOREIGN KEY (environment_id)
        REFERENCES public.environments(id) ON DELETE CASCADE,
    CONSTRAINT environment_connections_connection_id_fkey FOREIGN KEY (connection_id)
        REFERENCES public.connections(id) ON DELETE CASCADE
);

ALTER TABLE public.workflow_env_pointers ADD COLUMN IF NOT EXISTS environment_id uuid;
ALTER TABLE public.runtime_runs ADD COLUMN IF NOT EXISTS environment_id uuid;
-- `runtime_triggers` is dropped by 014; every reference to it here is guarded so
-- the re-run is a no-op once it is gone.
DO $$
BEGIN
  IF to_regclass('public.runtime_triggers') IS NOT NULL THEN
    ALTER TABLE public.runtime_triggers ADD COLUMN IF NOT EXISTS environment_id uuid;
  END IF;
END $$;

-- ADD CONSTRAINT has no IF NOT EXISTS — guard the re-apply explicitly.
DO $$
BEGIN
    -- A pointer is meaningless without its environment — deleting the env
    -- drops the pointer (the service counts them first for the delete receipt).
    ALTER TABLE public.workflow_env_pointers
        ADD CONSTRAINT workflow_env_pointers_environment_id_fkey FOREIGN KEY (environment_id)
            REFERENCES public.environments(id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    -- Deleting an env unbinds its triggers (they become Default), never deletes them.
    IF to_regclass('public.runtime_triggers') IS NOT NULL THEN
        ALTER TABLE public.runtime_triggers
            ADD CONSTRAINT runtime_triggers_environment_id_fkey FOREIGN KEY (environment_id)
                REFERENCES public.environments(id) ON DELETE SET NULL;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    -- Runs are history: they keep their environment NAME snapshot forever.
    ALTER TABLE public.runtime_runs
        ADD CONSTRAINT runtime_runs_environment_id_fkey FOREIGN KEY (environment_id)
            REFERENCES public.environments(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── Backfill 1: an environments row per DISTINCT legacy env string per org ──
-- The `EXISTS (… organizations …)` guards are load-bearing: connections/workflows
-- carry(ed) no org_id FK, so an ORPHAN org_id (org already gone) would make this
-- INSERT violate environments_org_id_fkey — and ON CONFLICT only catches the
-- unique-name collision, not the FK, so the whole migration would abort and starve
-- every later migration. Skipping orphan-org rows keeps the re-run safe (migration
-- 016 then adds the connections FK so orphans can't recur).
INSERT INTO public.environments (org_id, name, is_prod)
SELECT legacy.org_id, legacy.name, (legacy.name = 'prod')
  FROM (
    SELECT DISTINCT c.org_id, lower(c.environment) AS name
      FROM public.connections c
     WHERE c.org_id IS NOT NULL AND c.environment IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c.org_id)
    UNION
    SELECT DISTINCT w.org_id, lower(p.environment)
      FROM public.workflow_env_pointers p
      JOIN public.workflows w ON w.id = p.workflow_id
     WHERE w.org_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = w.org_id)
  ) legacy
ON CONFLICT (org_id, lower(name)) DO NOTHING;

-- The runtime_triggers-sourced env names, only while that (legacy) table survives.
DO $$
BEGIN
  IF to_regclass('public.runtime_triggers') IS NOT NULL THEN
    INSERT INTO public.environments (org_id, name, is_prod)
    SELECT DISTINCT w.org_id, lower(t.environment), (lower(t.environment) = 'prod')
      FROM public.runtime_triggers t
      JOIN public.workflows w ON w.id = t.workflow_id
     WHERE t.environment IS NOT NULL AND w.org_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = w.org_id)
    ON CONFLICT (org_id, lower(name)) DO NOTHING;
  END IF;
END $$;

-- ── Backfill 2: pointers/triggers get their environment_id (per the workflow's org) ──
UPDATE public.workflow_env_pointers p
   SET environment_id = e.id
  FROM public.workflows w, public.environments e
 WHERE p.environment_id IS NULL
   AND w.id = p.workflow_id
   AND e.org_id = w.org_id
   AND lower(e.name) = lower(p.environment);

DO $$
BEGIN
  IF to_regclass('public.runtime_triggers') IS NOT NULL THEN
    UPDATE public.runtime_triggers t
       SET environment_id = e.id
      FROM public.workflows w, public.environments e
     WHERE t.environment_id IS NULL
       AND t.environment IS NOT NULL
       AND w.id = t.workflow_id
       AND e.org_id = w.org_id
       AND lower(e.name) = lower(t.environment);
  END IF;
END $$;

-- ── Backfill 3: legacy cluster connections become slot rows (references —
--    the connection rows themselves are untouched) ──
INSERT INTO public.environment_connections (environment_id, app, connection_id)
SELECT e.id, c.provider, c.id
  FROM public.connections c
  JOIN public.environments e
    ON e.org_id = c.org_id AND lower(e.name) = lower(c.environment)
 WHERE c.org_id IS NOT NULL AND c.environment IS NOT NULL
ON CONFLICT (environment_id, app) DO NOTHING;
