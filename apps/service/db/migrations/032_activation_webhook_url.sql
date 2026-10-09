-- 032 — an activation records the intake URL a provider was told to deliver to, so a changed URL registers again.
-- Existing rows get NULL: a registered webhook is registered once more at its current URL; no other kind has a URL.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_trigger_activations ADD COLUMN IF NOT EXISTS webhook_url text;
