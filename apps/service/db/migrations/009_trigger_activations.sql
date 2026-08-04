-- 009 — trigger activations (triggers in the canvas).
--
-- A trigger is an IR node in the version doc; the live schedule/poller/
-- subscription set is DERIVED STATE reconciled from
--   DESIRED = ⋃ env-pointers × version-doc trigger nodes
-- against ACTUAL = runtime_trigger_activations. Only an env-pointer move
-- (promote/unpromote/publish/restore) or a slot change alters an activation —
-- never a commit (Save ≠ Live). The reconciler owns every write to these tables.
--
-- `runtime_activation_store` holds the per-activation cursors (polling/dedup,
-- schedule last-fire, registered-webhook secret + subscription handle) and
-- cascades with its row.

CREATE TABLE IF NOT EXISTS public.runtime_trigger_activations (
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    trigger_node_id character varying(64) NOT NULL,
    kind character varying(40) NOT NULL,
    trigger_type character varying(300) NOT NULL,
    version_id uuid,
    props json,
    connection_id uuid,
    connection_owner_user_id uuid,
    paused boolean DEFAULT false NOT NULL,
    last_polled_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_trigger_activations_pkey PRIMARY KEY (id),
    CONSTRAINT uq_activation_wf_env_node UNIQUE (workflow_id, environment_id, trigger_node_id),
    CONSTRAINT runtime_trigger_activations_workflow_id_fkey FOREIGN KEY (workflow_id)
        REFERENCES public.workflows(id) ON DELETE CASCADE,
    CONSTRAINT runtime_trigger_activations_environment_id_fkey FOREIGN KEY (environment_id)
        REFERENCES public.environments(id) ON DELETE CASCADE,
    CONSTRAINT runtime_trigger_activations_version_id_fkey FOREIGN KEY (version_id)
        REFERENCES public.workflow_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_activation_workflow ON public.runtime_trigger_activations USING btree (workflow_id);
CREATE INDEX IF NOT EXISTS ix_activation_kind ON public.runtime_trigger_activations USING btree (kind);

CREATE TABLE IF NOT EXISTS public.runtime_activation_store (
    activation_id uuid NOT NULL,
    key character varying(300) NOT NULL,
    value json,
    CONSTRAINT runtime_activation_store_pkey PRIMARY KEY (activation_id, key),
    CONSTRAINT runtime_activation_store_activation_id_fkey FOREIGN KEY (activation_id)
        REFERENCES public.runtime_trigger_activations(id) ON DELETE CASCADE
);
