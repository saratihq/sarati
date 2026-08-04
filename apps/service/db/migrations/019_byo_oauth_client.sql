-- 019 — bring-your-own OAuth client storage.
-- A user may register their OWN OAuth app instead of the per-deployment env
-- client. The client is Fernet-encrypted JSON, carried from authorize → callback
-- on oauth_states, then retained on the connection so token refresh redeems
-- against the same client.
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS oauth_client text;
ALTER TABLE public.connections ADD COLUMN IF NOT EXISTS oauth_client text;
