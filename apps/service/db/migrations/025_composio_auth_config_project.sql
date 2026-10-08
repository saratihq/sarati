-- 025 — a Composio auth config belongs to the project that holds it.
--
-- The record of which auth config to connect an app with was keyed by the app
-- alone. After the API key moved to another Composio project — or when two
-- workspaces use different projects — a connect handed one project the other's
-- auth config and Composio refused it. Rows are now keyed by a hash of the key
-- that found them as well. The old rows are dropped: on a miss the project's
-- own auth config is looked up again, so nothing is created twice.

ALTER TABLE public.composio_auth_configs
    ADD COLUMN IF NOT EXISTS project_key character varying(64);

DELETE FROM public.composio_auth_configs WHERE project_key IS NULL;

ALTER TABLE public.composio_auth_configs ALTER COLUMN project_key SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'composio_auth_configs_project_pkey') THEN
        ALTER TABLE public.composio_auth_configs DROP CONSTRAINT IF EXISTS composio_auth_configs_pkey;
        ALTER TABLE public.composio_auth_configs
            ADD CONSTRAINT composio_auth_configs_project_pkey PRIMARY KEY (project_key, toolkit_slug);
    END IF;
END $$;
