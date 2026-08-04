-- 014 — drop the legacy per-row trigger system. Triggers are NODES in the version
-- doc now: the reconciler materializes `runtime_trigger_activations` from env
-- pointers × version-doc trigger nodes, and the per-`(workflow, env)` webhook
-- intake fires the pinned version.
--
-- 003/006/008 guard their `runtime_triggers` references with `to_regclass`, so
-- re-running the whole chain after this drop stays green.

-- The store cascades with its parent, but drop it first: its FK references
-- runtime_triggers, and CASCADE covers any lingering dependency.
DROP TABLE IF EXISTS public.runtime_trigger_store CASCADE;
DROP TABLE IF EXISTS public.runtime_triggers CASCADE;

-- Unread credential vestiges. The inert github_* columns are a separate cleanup.
ALTER TABLE public.user_settings DROP COLUMN IF EXISTS n8n_api_key;
ALTER TABLE public.user_settings DROP COLUMN IF EXISTS n8n_url;
