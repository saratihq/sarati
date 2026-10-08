-- 025 — which account a connection is authorized against, as the provider answers it.
--
-- A connection only knew its app, so nothing could say whose Gmail it was and a
-- step had no way to send "to me". The provider's own who-am-I answer is stored
-- on the row; account_checked_at records that it was asked, so a null account
-- with a time set means the provider would not say.

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS account jsonb,
    ADD COLUMN IF NOT EXISTS account_checked_at timestamp with time zone;
