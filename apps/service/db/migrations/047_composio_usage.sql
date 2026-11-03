-- 047 — each person's use of the instance's own Composio account (INSTANCE_COMPOSIO_API_KEY) per UTC calendar month: the app
-- actions charged before each is sent, capped per person, and the trigger events delivered for their accounts. Empty on an
-- install where each person or workspace sets their own Composio key.
-- Idempotent: db:migrate re-runs every file.

CREATE TABLE IF NOT EXISTS public.composio_usage (
    user_id uuid NOT NULL,
    month date NOT NULL,
    actions integer DEFAULT 0 NOT NULL,
    trigger_events integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT composio_usage_pkey PRIMARY KEY (user_id, month),
    CONSTRAINT composio_usage_month_start CHECK (EXTRACT(day FROM month) = 1),
    CONSTRAINT composio_usage_counts_check CHECK (actions >= 0 AND trigger_events >= 0),
    CONSTRAINT composio_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);
