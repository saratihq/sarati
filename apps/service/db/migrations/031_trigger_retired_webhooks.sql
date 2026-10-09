-- 031 — an app webhook whose delete failed, kept apart from any activation so later reconciles retry it.
-- No foreign keys: a pending delete must outlive the trigger, workflow and environment it was registered for.
-- Idempotent: db:migrate re-runs every file.

CREATE TABLE IF NOT EXISTS public.trigger_retired_webhooks (
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    trigger_node_id character varying(64) NOT NULL,
    webhook jsonb NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trigger_retired_webhooks_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS ix_trigger_retired_webhooks_workflow
    ON public.trigger_retired_webhooks (workflow_id);
