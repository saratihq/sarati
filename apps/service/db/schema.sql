--
-- PostgreSQL database dump
--

\restrict JhBUP2BYpXkELMHggQFED1Fg0TcwlHaJYTzEdDpncgnkx434dPhhffusTa5HYm5

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: approvaldecision; Type: TYPE; Schema: public; Owner: orchestr
--

CREATE TYPE public.approvaldecision AS ENUM (
    'approved',
    'rejected',
    'commented'
);



--
-- Name: reviewstatus; Type: TYPE; Schema: public; Owner: orchestr
--

CREATE TYPE public.reviewstatus AS ENUM (
    'open',
    'approved',
    'rejected',
    'merged',
    'closed'
);



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.api_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid,
    name character varying(120) NOT NULL,
    key_hash character varying(128) NOT NULL,
    prefix character varying(12) NOT NULL,
    scopes json,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: composer_thread_events; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.composer_thread_events (
    thread_id uuid NOT NULL,
    seq integer NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: composer_threads; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.composer_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_key text NOT NULL,
    workflow_id uuid,
    sdk_session_id text,
    last_seq integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: composio_auth_configs; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.composio_auth_configs (
    toolkit_slug character varying(120) NOT NULL,
    auth_config_id character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: connections; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(120) NOT NULL,
    display_name character varying(200),
    auth_type character varying(30) NOT NULL,
    credential text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    org_id uuid,
    environment character varying(100),
    status_reason text,
    last_checked_at timestamp with time zone,
    oauth_client text
);



--
-- Name: domain_events; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.domain_events (
    id uuid NOT NULL,
    org_id uuid,
    actor_user_id uuid,
    actor_type character varying(20) DEFAULT 'user'::character varying NOT NULL,
    type character varying(100) NOT NULL,
    subject_type character varying(50),
    subject_id character varying(64),
    payload json,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: environment_connections; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.environment_connections (
    environment_id uuid NOT NULL,
    app text NOT NULL,
    connection_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: environments; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.environments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    is_prod boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.idempotency_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    method character varying(10) NOT NULL,
    path character varying(500) NOT NULL,
    status_code integer,
    response_body json,
    completed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: node_icons; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.node_icons (
    node_type character varying(255) NOT NULL,
    svg text NOT NULL,
    source character varying(50) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: oauth_states; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.oauth_states (
    id uuid NOT NULL,
    state character varying(255) NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(120),
    code_verifier character varying(255),
    oauth_client text,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL
);



--
-- Name: org_invites; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.org_invites (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    email character varying(320) NOT NULL,
    role character varying(20) DEFAULT 'member'::character varying NOT NULL,
    token character varying(80) NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone
);



--
-- Name: org_members; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.org_members (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: organizations; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.organizations (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    is_personal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);



--
-- Name: review_approvals; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.review_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    decision public.approvaldecision NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: review_comments; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.review_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    node_id character varying(50),
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: runtime_activation_store; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.runtime_activation_store (
    activation_id uuid NOT NULL,
    key character varying(300) NOT NULL,
    value json
);



--
-- Name: runtime_blobs; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.runtime_blobs (
    id uuid NOT NULL,
    run_id character varying(200) NOT NULL,
    filename character varying(500) NOT NULL,
    mime_type character varying(255) NOT NULL,
    size_bytes integer NOT NULL,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: runtime_run_steps; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.runtime_run_steps (
    id uuid NOT NULL,
    run_id character varying(200) NOT NULL,
    step_key character varying(300) NOT NULL,
    node_id character varying(200) NOT NULL,
    kind character varying(20) NOT NULL,
    status character varying(20) NOT NULL,
    output json,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    pinned boolean DEFAULT false NOT NULL,
    continued boolean DEFAULT false NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    warnings json
);



--
-- Name: runtime_runs; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.runtime_runs (
    id character varying(200) NOT NULL,
    run_id character varying(120) NOT NULL,
    user_id uuid NOT NULL,
    plan_id character varying(200) NOT NULL,
    plan json,
    status character varying(20) DEFAULT 'running'::character varying NOT NULL,
    outputs json,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    workflow_id uuid,
    source character varying(20),
    waiting_node_id character varying(200),
    waiting_topic character varying(200),
    waiting_since timestamp with time zone,
    waiting_timeout_at timestamp with time zone,
    decided_by uuid,
    decided_at timestamp with time zone,
    environment character varying(100),
    workflow_version_id uuid,
    environment_id uuid,
    review_id uuid,
    dry_run boolean DEFAULT false NOT NULL
);



--
-- Name: runtime_trigger_activations; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.runtime_trigger_activations (
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    trigger_node_id character varying(64) NOT NULL,
    kind character varying(40) NOT NULL,
    trigger_type character varying(300) NOT NULL,
    version_id uuid,
    props json,
    composio_trigger_instance_id character varying(64),
    connection_id uuid,
    connection_owner_user_id uuid,
    paused boolean DEFAULT false NOT NULL,
    last_polled_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.user_settings (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    github_token character varying(500),
    github_repo character varying(255),
    github_sync_enabled boolean DEFAULT false NOT NULL
);



--
-- Name: users; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email character varying(255) NOT NULL,
    hashed_password character varying(255),
    name character varying(255) NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    clerk_user_id character varying(64)
);



--
-- Name: composio_webhook_deliveries; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.composio_webhook_deliveries (
    webhook_id text NOT NULL,
    trigger_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: webhook_trigger_secrets; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.webhook_trigger_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    environment_id uuid,
    node_id text NOT NULL,
    secret text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: platform_secrets; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.platform_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    user_id uuid,
    org_id uuid,
    secret text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_secrets_name_check CHECK ((name = ANY (ARRAY['composio_api_key'::text, 'composio_webhook_secret'::text, 'anthropic_api_key'::text]))),
    CONSTRAINT platform_secrets_one_owner CHECK (((user_id IS NULL) <> (org_id IS NULL)))
);



--
-- Name: workflow_branches; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.workflow_branches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    head_version_id uuid,
    created_by uuid,
    is_default boolean DEFAULT false NOT NULL,
    is_protected boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);



--
-- Name: workflow_env_pointers; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.workflow_env_pointers (
    workflow_id uuid NOT NULL,
    environment character varying(100) NOT NULL,
    version_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    environment_id uuid
);



--
-- Name: workflow_reviews; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.workflow_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    source_branch_id uuid NOT NULL,
    target_branch_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    status public.reviewstatus DEFAULT 'open'::public.reviewstatus NOT NULL,
    author_id uuid NOT NULL,
    merged_version_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_test json
);



--
-- Name: workflow_version_tags; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.workflow_version_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    version_id uuid NOT NULL,
    tag character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    branch_id uuid,
    activated boolean DEFAULT true NOT NULL
);



--
-- Name: workflow_versions; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.workflow_versions (
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    version_number integer NOT NULL,
    workflow_json json NOT NULL,
    diff text,
    commit_message character varying(500),
    created_at timestamp with time zone DEFAULT now(),
    author character varying(255),
    workflow_ir json,
    ir_diff json,
    branch_id uuid,
    parent_id uuid,
    merge_parent_id uuid
);



--
-- Name: workflows; Type: TABLE; Schema: public; Owner: orchestr
--

CREATE TABLE public.workflows (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    active_version_id uuid,
    user_id uuid,
    default_branch_id uuid,
    source character varying(20) DEFAULT 'generated'::character varying NOT NULL,
    org_id uuid
);



--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: composer_thread_events composer_thread_events_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.composer_thread_events
    ADD CONSTRAINT composer_thread_events_pkey PRIMARY KEY (thread_id, seq);


--
-- Name: composer_threads composer_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.composer_threads
    ADD CONSTRAINT composer_threads_pkey PRIMARY KEY (id);


--
-- Name: composio_auth_configs composio_auth_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.composio_auth_configs
    ADD CONSTRAINT composio_auth_configs_pkey PRIMARY KEY (toolkit_slug);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: domain_events domain_events_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_pkey PRIMARY KEY (id);


--
-- Name: environment_connections environment_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.environment_connections
    ADD CONSTRAINT environment_connections_pkey PRIMARY KEY (environment_id, app);


--
-- Name: environments environments_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: node_icons node_icons_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.node_icons
    ADD CONSTRAINT node_icons_pkey PRIMARY KEY (node_type);


--
-- Name: oauth_states oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (id);


--
-- Name: org_invites org_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);


--
-- Name: org_invites org_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_token_key UNIQUE (token);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: review_approvals review_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.review_approvals
    ADD CONSTRAINT review_approvals_pkey PRIMARY KEY (id);


--
-- Name: review_comments review_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.review_comments
    ADD CONSTRAINT review_comments_pkey PRIMARY KEY (id);


--
-- Name: runtime_activation_store runtime_activation_store_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_activation_store
    ADD CONSTRAINT runtime_activation_store_pkey PRIMARY KEY (activation_id, key);


--
-- Name: runtime_blobs runtime_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_blobs
    ADD CONSTRAINT runtime_blobs_pkey PRIMARY KEY (id);


--
-- Name: runtime_run_steps runtime_run_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_run_steps
    ADD CONSTRAINT runtime_run_steps_pkey PRIMARY KEY (id);


--
-- Name: runtime_runs runtime_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_runs
    ADD CONSTRAINT runtime_runs_pkey PRIMARY KEY (id);


--
-- Name: runtime_trigger_activations runtime_trigger_activations_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_trigger_activations
    ADD CONSTRAINT runtime_trigger_activations_pkey PRIMARY KEY (id);


--
-- Name: runtime_trigger_activations uq_activation_wf_env_node; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_trigger_activations
    ADD CONSTRAINT uq_activation_wf_env_node UNIQUE (workflow_id, environment_id, trigger_node_id);


--
-- Name: workflow_branches uq_branch_workflow_name; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT uq_branch_workflow_name UNIQUE (workflow_id, name);


--
-- Name: idempotency_keys uq_idempotency_user_key; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT uq_idempotency_user_key UNIQUE (user_id, idempotency_key);


--
-- Name: org_members uq_org_member; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT uq_org_member UNIQUE (org_id, user_id);


--
-- Name: runtime_run_steps uq_runtime_run_steps_run_step; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_run_steps
    ADD CONSTRAINT uq_runtime_run_steps_run_step UNIQUE (run_id, step_key);


--
-- Name: workflow_versions uq_version_branch_number; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT uq_version_branch_number UNIQUE (workflow_id, branch_id, version_number);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_user_id_key; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_key UNIQUE (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: composio_webhook_deliveries composio_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.composio_webhook_deliveries
    ADD CONSTRAINT composio_webhook_deliveries_pkey PRIMARY KEY (webhook_id);


--
-- Name: idx_composio_webhook_deliveries_received_at; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX idx_composio_webhook_deliveries_received_at ON public.composio_webhook_deliveries USING btree (received_at);


--
-- Name: webhook_trigger_secrets webhook_trigger_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.webhook_trigger_secrets
    ADD CONSTRAINT webhook_trigger_secrets_pkey PRIMARY KEY (id);


--
-- Name: platform_secrets platform_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.platform_secrets
    ADD CONSTRAINT platform_secrets_pkey PRIMARY KEY (id);


--
-- Name: uq_platform_secret_user; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_platform_secret_user ON public.platform_secrets USING btree (name, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: uq_platform_secret_org; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_platform_secret_org ON public.platform_secrets USING btree (name, org_id) WHERE (org_id IS NOT NULL);


--
-- Name: platform_secrets platform_secrets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.platform_secrets
    ADD CONSTRAINT platform_secrets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: platform_secrets platform_secrets_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.platform_secrets
    ADD CONSTRAINT platform_secrets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workflow_branches workflow_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_pkey PRIMARY KEY (id);


--
-- Name: workflow_env_pointers workflow_env_pointers_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_env_pointers
    ADD CONSTRAINT workflow_env_pointers_pkey PRIMARY KEY (workflow_id, environment);


--
-- Name: workflow_reviews workflow_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_reviews
    ADD CONSTRAINT workflow_reviews_pkey PRIMARY KEY (id);


--
-- Name: workflow_version_tags workflow_version_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_version_tags
    ADD CONSTRAINT workflow_version_tags_pkey PRIMARY KEY (id);


--
-- Name: workflow_versions workflow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: ix_activation_composio_instance; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_activation_composio_instance ON public.runtime_trigger_activations USING btree (composio_trigger_instance_id);


--
-- Name: ix_activation_kind; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_activation_kind ON public.runtime_trigger_activations USING btree (kind);


--
-- Name: ix_activation_workflow; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_activation_workflow ON public.runtime_trigger_activations USING btree (workflow_id);


--
-- Name: ix_api_keys_prefix; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_api_keys_prefix ON public.api_keys USING btree (prefix);


--
-- Name: ix_api_keys_user_id; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_api_keys_user_id ON public.api_keys USING btree (user_id);


--
-- Name: ix_domain_events_created_at; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_domain_events_created_at ON public.domain_events USING btree (created_at);


--
-- Name: ix_domain_events_org_created; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_domain_events_org_created ON public.domain_events USING btree (org_id, created_at);


--
-- Name: ix_domain_events_type; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_domain_events_type ON public.domain_events USING btree (type);


--
-- Name: ix_idempotency_keys_created_at; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_idempotency_keys_created_at ON public.idempotency_keys USING btree (created_at);


--
-- Name: ix_oauth_states_state; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX ix_oauth_states_state ON public.oauth_states USING btree (state);


--
-- Name: ix_org_invites_org_id; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_org_invites_org_id ON public.org_invites USING btree (org_id);


--
-- Name: ix_org_members_org_id; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_org_members_org_id ON public.org_members USING btree (org_id);


--
-- Name: ix_org_members_user_id; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_org_members_user_id ON public.org_members USING btree (user_id);


--
-- Name: ix_review_approvals_review; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_review_approvals_review ON public.review_approvals USING btree (review_id);


--
-- Name: ix_runtime_blobs_run; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_runtime_blobs_run ON public.runtime_blobs USING btree (run_id);


--
-- Name: ix_runtime_runs_user_started; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_runtime_runs_user_started ON public.runtime_runs USING btree (user_id, started_at DESC);


--
-- Name: ix_runtime_runs_workflow; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_runtime_runs_workflow ON public.runtime_runs USING btree (workflow_id);


--
-- Name: ix_users_clerk_user_id; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX ix_users_clerk_user_id ON public.users USING btree (clerk_user_id);


--
-- Name: ix_users_email; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX ix_users_email ON public.users USING btree (email);


--
-- Name: ix_workflow_branches_wf; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_workflow_branches_wf ON public.workflow_branches USING btree (workflow_id);


--
-- Name: ix_workflow_reviews_wf; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_workflow_reviews_wf ON public.workflow_reviews USING btree (workflow_id);


--
-- Name: ix_workflow_version_tags_tag; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_workflow_version_tags_tag ON public.workflow_version_tags USING btree (tag);


--
-- Name: ix_workflow_version_tags_wf; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_workflow_version_tags_wf ON public.workflow_version_tags USING btree (workflow_id);


--
-- Name: ix_workflow_versions_wf_branch; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_workflow_versions_wf_branch ON public.workflow_versions USING btree (workflow_id, branch_id);


--
-- Name: ix_workflows_org_id; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE INDEX ix_workflows_org_id ON public.workflows USING btree (org_id);


--
-- Name: uq_api_keys_key_hash; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_api_keys_key_hash ON public.api_keys USING btree (key_hash);


--
-- Name: uq_composer_threads_user_scratch; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_composer_threads_user_scratch ON public.composer_threads USING btree (user_key) WHERE (workflow_id IS NULL);


--
-- Name: uq_composer_threads_user_workflow; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_composer_threads_user_workflow ON public.composer_threads USING btree (user_key, workflow_id) WHERE (workflow_id IS NOT NULL);


--
-- Name: uq_connections_org_env_provider; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_connections_org_env_provider ON public.connections USING btree (org_id, environment, provider) WHERE (org_id IS NOT NULL);


--
-- Name: uq_environments_org_lower_name; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_environments_org_lower_name ON public.environments USING btree (org_id, lower(name));


--
-- Name: uq_per_branch_tag; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_per_branch_tag ON public.workflow_version_tags USING btree (workflow_id, tag, branch_id) WHERE ((tag)::text = ANY (ARRAY[('dev'::character varying)::text, ('latest'::character varying)::text]));


--
-- Name: uq_tag_per_workflow_exclusive; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_tag_per_workflow_exclusive ON public.workflow_version_tags USING btree (workflow_id, tag) WHERE ((tag)::text <> ALL (ARRAY[('dev'::character varying)::text, ('latest'::character varying)::text]));


--
-- Name: uq_webhook_secret_wf_env_node; Type: INDEX; Schema: public; Owner: orchestr
--

CREATE UNIQUE INDEX uq_webhook_secret_wf_env_node ON public.webhook_trigger_secrets USING btree (workflow_id, COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'::uuid), node_id);


--
-- Name: api_keys api_keys_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: composer_thread_events composer_thread_events_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.composer_thread_events
    ADD CONSTRAINT composer_thread_events_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.composer_threads(id) ON DELETE CASCADE;


--
-- Name: composer_threads composer_threads_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.composer_threads
    ADD CONSTRAINT composer_threads_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: connections connections_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: connections connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: domain_events domain_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: domain_events domain_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: environment_connections environment_connections_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.environment_connections
    ADD CONSTRAINT environment_connections_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE CASCADE;


--
-- Name: environment_connections environment_connections_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.environment_connections
    ADD CONSTRAINT environment_connections_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environments environments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workflows fk_workflows_active_version; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT fk_workflows_active_version FOREIGN KEY (active_version_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: workflows fk_workflows_organization; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT fk_workflows_organization FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: workflows fk_workflows_user_id; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT fk_workflows_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: idempotency_keys idempotency_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: oauth_states oauth_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_invites org_invites_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_approvals review_approvals_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.review_approvals
    ADD CONSTRAINT review_approvals_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.workflow_reviews(id) ON DELETE CASCADE;


--
-- Name: review_approvals review_approvals_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.review_approvals
    ADD CONSTRAINT review_approvals_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_comments review_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.review_comments
    ADD CONSTRAINT review_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_comments review_comments_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.review_comments
    ADD CONSTRAINT review_comments_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.workflow_reviews(id) ON DELETE CASCADE;


--
-- Name: runtime_activation_store runtime_activation_store_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_activation_store
    ADD CONSTRAINT runtime_activation_store_activation_id_fkey FOREIGN KEY (activation_id) REFERENCES public.runtime_trigger_activations(id) ON DELETE CASCADE;


--
-- Name: runtime_run_steps runtime_run_steps_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_run_steps
    ADD CONSTRAINT runtime_run_steps_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runtime_runs(id) ON DELETE CASCADE;


--
-- Name: runtime_runs runtime_runs_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_runs
    ADD CONSTRAINT runtime_runs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE SET NULL;


--
-- Name: runtime_runs runtime_runs_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_runs
    ADD CONSTRAINT runtime_runs_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE SET NULL;


--
-- Name: runtime_runs runtime_runs_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_runs
    ADD CONSTRAINT runtime_runs_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: runtime_trigger_activations runtime_trigger_activations_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_trigger_activations
    ADD CONSTRAINT runtime_trigger_activations_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: runtime_trigger_activations runtime_trigger_activations_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_trigger_activations
    ADD CONSTRAINT runtime_trigger_activations_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: runtime_trigger_activations runtime_trigger_activations_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.runtime_trigger_activations
    ADD CONSTRAINT runtime_trigger_activations_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: webhook_trigger_secrets webhook_trigger_secrets_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.webhook_trigger_secrets
    ADD CONSTRAINT webhook_trigger_secrets_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: webhook_trigger_secrets webhook_trigger_secrets_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.webhook_trigger_secrets
    ADD CONSTRAINT webhook_trigger_secrets_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_branches workflow_branches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workflow_branches workflow_branches_head_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_head_version_id_fkey FOREIGN KEY (head_version_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: workflow_branches workflow_branches_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_env_pointers workflow_env_pointers_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_env_pointers
    ADD CONSTRAINT workflow_env_pointers_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: workflow_env_pointers workflow_env_pointers_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_env_pointers
    ADD CONSTRAINT workflow_env_pointers_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.workflow_versions(id) ON DELETE CASCADE;


--
-- Name: workflow_env_pointers workflow_env_pointers_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_env_pointers
    ADD CONSTRAINT workflow_env_pointers_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_reviews workflow_reviews_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_reviews
    ADD CONSTRAINT workflow_reviews_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workflow_reviews workflow_reviews_merged_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_reviews
    ADD CONSTRAINT workflow_reviews_merged_version_id_fkey FOREIGN KEY (merged_version_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: workflow_reviews workflow_reviews_source_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_reviews
    ADD CONSTRAINT workflow_reviews_source_branch_id_fkey FOREIGN KEY (source_branch_id) REFERENCES public.workflow_branches(id) ON DELETE CASCADE;


--
-- Name: workflow_reviews workflow_reviews_target_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_reviews
    ADD CONSTRAINT workflow_reviews_target_branch_id_fkey FOREIGN KEY (target_branch_id) REFERENCES public.workflow_branches(id) ON DELETE CASCADE;


--
-- Name: workflow_reviews workflow_reviews_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_reviews
    ADD CONSTRAINT workflow_reviews_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_version_tags workflow_version_tags_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_version_tags
    ADD CONSTRAINT workflow_version_tags_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.workflow_branches(id) ON DELETE SET NULL;


--
-- Name: workflow_version_tags workflow_version_tags_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_version_tags
    ADD CONSTRAINT workflow_version_tags_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.workflow_versions(id) ON DELETE CASCADE;


--
-- Name: workflow_version_tags workflow_version_tags_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_version_tags
    ADD CONSTRAINT workflow_version_tags_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_versions workflow_versions_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.workflow_branches(id) ON DELETE SET NULL;


--
-- Name: workflow_versions workflow_versions_merge_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_merge_parent_id_fkey FOREIGN KEY (merge_parent_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: workflow_versions workflow_versions_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;


--
-- Name: workflow_versions workflow_versions_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflows workflows_default_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: orchestr
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_default_branch_id_fkey FOREIGN KEY (default_branch_id) REFERENCES public.workflow_branches(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict JhBUP2BYpXkELMHggQFED1Fg0TcwlHaJYTzEdDpncgnkx434dPhhffusTa5HYm5

