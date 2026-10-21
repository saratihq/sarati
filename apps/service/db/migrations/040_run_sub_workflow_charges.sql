-- 040 — each sub-workflow call an agent makes in a run tree, charged once against the tree's root run, so the cap holds
-- across concurrent children and a call charged before a crash is not charged again. `lineage` names the runs between
-- the root and the one that charged, so a called run that runs again replaces its previous attempt's charges.
-- Idempotent: db:migrate re-runs every file.

CREATE TABLE IF NOT EXISTS public.runtime_sub_workflow_charges (
    root_run_id character varying(200) NOT NULL,
    call_key character varying(600) NOT NULL,
    allowed boolean NOT NULL,
    charged_at timestamp with time zone DEFAULT now() NOT NULL,
    lineage character varying(200)[] DEFAULT '{}'::character varying[] NOT NULL,
    CONSTRAINT runtime_sub_workflow_charges_pkey PRIMARY KEY (root_run_id, call_key),
    CONSTRAINT runtime_sub_workflow_charges_root_run_id_fkey FOREIGN KEY (root_run_id)
        REFERENCES public.runtime_runs(id) ON DELETE CASCADE
);

ALTER TABLE public.runtime_sub_workflow_charges
    ADD COLUMN IF NOT EXISTS lineage character varying(200)[] DEFAULT '{}'::character varying[] NOT NULL;
