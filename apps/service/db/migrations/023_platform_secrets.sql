-- 023 — the optional platform API keys, set from Settings rather than the environment.
--
-- COMPOSIO_API_KEY and ANTHROPIC_API_KEY used to be env-only, so turning either
-- capability on meant editing .env and restarting the stack. They now live here,
-- Fernet-encrypted via EncryptionService, and are read per call so a key entered in
-- the UI takes effect without a restart.
--
-- A key belongs to a USER or to an ORGANIZATION, never to the instance: the owner
-- check enforces exactly one of the two, so there is no row an instance-wide reader
-- could resolve. Resolution follows the caller's active org — a real org uses the
-- org's key, a personal context uses the user's own.
--
-- The name CHECK is the guard against this becoming a general secrets manager: the
-- set of names is closed, and widening it is a deliberate migration.

CREATE TABLE IF NOT EXISTS public.platform_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    user_id uuid,
    org_id uuid,
    secret text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_secrets_pkey PRIMARY KEY (id),
    CONSTRAINT platform_secrets_name_check CHECK (name IN ('composio_api_key', 'composio_webhook_secret', 'anthropic_api_key')),
    CONSTRAINT platform_secrets_one_owner CHECK ((user_id IS NULL) <> (org_id IS NULL)),
    CONSTRAINT platform_secrets_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT platform_secrets_org_id_fkey FOREIGN KEY (org_id)
        REFERENCES public.organizations(id) ON DELETE CASCADE
);

-- One key per name per owner. Partial indexes because the unused column is NULL, and
-- NULLs would not collide in a plain composite unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_secret_user
    ON public.platform_secrets (name, user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_secret_org
    ON public.platform_secrets (name, org_id) WHERE org_id IS NOT NULL;
