-- 041 — a live trigger whose slot's account stops being active is kept and held, so a reconnect resumes it from its cursor.
-- Existing rows are not held. Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_trigger_activations ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
