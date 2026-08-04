-- 010 — drop the legacy alternate-engine columns and tables. The product runs on
-- the native engine only: no import, no alternate engines, no engine_type. Legacy
-- workflow ROWS are purged out-of-band first — once engine_type is gone they can
-- no longer be told apart.

-- The engine-mirror columns on workflows.
ALTER TABLE public.workflows DROP COLUMN IF EXISTS engine_type;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS engine_connection_id;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS remote_workflow_id;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS n8n_workflow_id;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS github_slug;

-- The engine-deployment / drift columns on version tags (the tag is now just
-- the per-(workflow, branch) `latest` bookkeeping).
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS n8n_workflow_id;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS engine_connection_id;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS remote_workflow_id;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS activation_error;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS last_synced_n8n_updated_at;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS drift_n8n_json;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS drift_detected_at;
ALTER TABLE public.workflow_version_tags DROP COLUMN IF EXISTS drift_detected;

-- The engine-connection store and the execution-polling table go entirely.
DROP TABLE IF EXISTS public.engine_connections CASCADE;
DROP TABLE IF EXISTS public.executions CASCADE;

-- The executions status enum, orphaned once the table is gone.
DROP TYPE IF EXISTS public.executionstatus;
