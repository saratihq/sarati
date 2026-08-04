-- 005 — per-environment live pointers.
--
-- Generalizes the single `workflows.active_version_id` live pointer to one pointer
-- PER ENVIRONMENT: prod can run v5 while staging runs v7. Promotion moves a row;
-- only pointer moves change what runs (Save ≠ Live). `active_version_id` stays as
-- the legacy alias of the 'prod' row, kept in sync by the service on every prod
-- move. Runs gain the exact version they executed.
--
-- BACKFILL: every workflow with an active_version_id gets a 'prod' pointer row.

CREATE TABLE IF NOT EXISTS public.workflow_env_pointers (
    workflow_id uuid NOT NULL,
    environment character varying(100) NOT NULL,
    version_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_env_pointers_pkey PRIMARY KEY (workflow_id, environment),
    CONSTRAINT workflow_env_pointers_workflow_id_fkey FOREIGN KEY (workflow_id)
        REFERENCES public.workflows(id) ON DELETE CASCADE,
    CONSTRAINT workflow_env_pointers_version_id_fkey FOREIGN KEY (version_id)
        REFERENCES public.workflow_versions(id) ON DELETE CASCADE
);

-- Seed the live pointer ONLY for workflows that have no live pointer yet. The
-- NOT EXISTS is what keeps this idempotent across the ledger-free re-run: once
-- 008 has renamed 'prod' → 'production', this must NOT resurrect a 'prod' row
-- (which then collides with 'production' in 008's pointer rename and hard-aborts
-- db:migrate). The literal name is still 'prod' — 008 owns the rename.
INSERT INTO public.workflow_env_pointers (workflow_id, environment, version_id)
SELECT w.id, 'prod', w.active_version_id
  FROM public.workflows w
 WHERE w.active_version_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.workflow_env_pointers p
      WHERE p.workflow_id = w.id AND lower(p.environment) IN ('prod', 'production')
   )
ON CONFLICT (workflow_id, environment) DO NOTHING;

ALTER TABLE public.runtime_runs
    ADD COLUMN IF NOT EXISTS workflow_version_id uuid;

-- ADD CONSTRAINT has no IF NOT EXISTS — guard the re-apply explicitly.
DO $$
BEGIN
    ALTER TABLE public.runtime_runs
        ADD CONSTRAINT runtime_runs_workflow_version_id_fkey FOREIGN KEY (workflow_version_id)
            REFERENCES public.workflow_versions(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
