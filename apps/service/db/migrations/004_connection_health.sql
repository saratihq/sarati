-- 004 — connection health.
--
-- Failure paths (oauth2 refresh failure, Composio account expiry) persist a status
-- transition instead of only throwing at run time: `status` gains an 'expired'
-- value, `status_reason` carries the plain-language explanation the client shows,
-- and `last_checked_at` records when health was last verified.

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS status_reason text,
    ADD COLUMN IF NOT EXISTS last_checked_at timestamp with time zone;
