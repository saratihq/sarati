-- 017 — webhook signing secrets (native HMAC verification).
--
-- The signing SECRET is env-scoped and stored OUT of the version doc: secrets are
-- env config, never committed, diffed, or shown in a review. Only the NON-secret
-- verification config (preset/algo/header/format) lives on the `orchestr:webhook`
-- node params. Encrypted at rest via EncryptionService.

CREATE TABLE IF NOT EXISTS public.webhook_trigger_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    environment_id uuid,
    node_id text NOT NULL,
    secret text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_trigger_secrets_pkey PRIMARY KEY (id),
    CONSTRAINT webhook_trigger_secrets_workflow_id_fkey FOREIGN KEY (workflow_id)
        REFERENCES public.workflows(id) ON DELETE CASCADE,
    CONSTRAINT webhook_trigger_secrets_environment_id_fkey FOREIGN KEY (environment_id)
        REFERENCES public.environments(id) ON DELETE CASCADE
);

-- One secret per (workflow, environment, trigger node). COALESCE folds the org-less
-- NULL environment into a fixed sentinel so NULLs don't create duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_secret_wf_env_node
    ON public.webhook_trigger_secrets
       (workflow_id, COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'::uuid), node_id);
