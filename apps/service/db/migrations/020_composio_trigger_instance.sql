-- 020 — Composio trigger rail.
-- The `composio_subscription` activation kind subscribes a Composio trigger
-- INSTANCE on activate; its id (`ti_…`) is persisted here so the
-- `/api/hooks/composio` intake can map a delivery's `metadata.trigger_id` back to
-- the activation(s), and teardown can delete it. Refcounted: Composio dedupes on
-- connected_account+slug+config, so one instance can back several activations.
-- Nullable for every other kind.
ALTER TABLE public.runtime_trigger_activations
  ADD COLUMN IF NOT EXISTS composio_trigger_instance_id character varying(64);

-- Fan-out + refcount both look activations up by the instance id.
CREATE INDEX IF NOT EXISTS ix_activation_composio_instance
  ON public.runtime_trigger_activations USING btree (composio_trigger_instance_id);
