-- 001 — per-environment connection clusters. See db/README.md for how these run.

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS org_id uuid,
    ADD COLUMN IF NOT EXISTS environment character varying(100);

-- One account per app per environment within an org cluster. Personal rows
-- (org_id NULL) are exempt and keep the many-per-user behavior.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connections_org_env_provider
    ON public.connections (org_id, environment, provider) WHERE org_id IS NOT NULL;
