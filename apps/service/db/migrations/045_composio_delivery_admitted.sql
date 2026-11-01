-- 045 — a Composio delivery is a duplicate only once every run it starts is admitted (admitted_at); a resend of one claimed but not
-- admitted runs its activations again. A claim an earlier release made fired its runs as it was made, so it counts as admitted: those
-- already there, and, by the column's default, one it makes after a rollback, since this release alone claims with admitted_at NULL.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE composio_webhook_deliveries ADD COLUMN IF NOT EXISTS admitted_at timestamp with time zone DEFAULT now();
