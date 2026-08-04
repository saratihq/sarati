-- 007 — durable composer conversations.
--
-- Chats are keyed (user, workflow): one conversation per user per workflow,
-- version-independent. `apps/agent` owns every read and write of these tables —
-- this service owns the schema only, and has no entities for them. `user_key` is
-- the caller's `sub` (TEXT, no FK — the user may exist only in the IdP at first
-- sight). `workflow_id IS NULL` marks the user's ONE pre-save scratch thread,
-- re-keyed to the workflow on the accept path. Events store the exact wire event;
-- `seq` is the per-thread monotonic SSE id — replay starts at seq 1.

CREATE TABLE IF NOT EXISTS public.composer_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_key text NOT NULL,
    workflow_id uuid,
    sdk_session_id text,
    last_seq integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT composer_threads_pkey PRIMARY KEY (id),
    CONSTRAINT composer_threads_workflow_id_fkey FOREIGN KEY (workflow_id)
        REFERENCES public.workflows(id) ON DELETE CASCADE
);

-- One thread per (user, workflow) …
CREATE UNIQUE INDEX IF NOT EXISTS uq_composer_threads_user_workflow
    ON public.composer_threads (user_key, workflow_id) WHERE workflow_id IS NOT NULL;

-- … plus ONE scratch thread per user (the pre-save compose conversation).
CREATE UNIQUE INDEX IF NOT EXISTS uq_composer_threads_user_scratch
    ON public.composer_threads (user_key) WHERE workflow_id IS NULL;

CREATE TABLE IF NOT EXISTS public.composer_thread_events (
    thread_id uuid NOT NULL,
    seq integer NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT composer_thread_events_pkey PRIMARY KEY (thread_id, seq),
    CONSTRAINT composer_thread_events_thread_id_fkey FOREIGN KEY (thread_id)
        REFERENCES public.composer_threads(id) ON DELETE CASCADE
);
