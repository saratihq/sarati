-- 042 — single sign-on: the identities a person signs in with at an OpenID Connect provider, keyed by (issuer, subject),
-- and the single-use state a browser sign-in holds between its start and its completion.
-- Idempotent: db:migrate re-runs every file.

CREATE TABLE IF NOT EXISTS public.user_identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    issuer character varying(512) NOT NULL,
    subject character varying(255) NOT NULL,
    email_at_link character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    CONSTRAINT user_identities_pkey PRIMARY KEY (id),
    CONSTRAINT user_identities_issuer_subject_key UNIQUE (issuer, subject),
    CONSTRAINT user_identities_user_issuer_key UNIQUE (user_id, issuer),
    CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.oidc_login_states (
    state_hash character varying(64) NOT NULL,
    nonce character varying(64) NOT NULL,
    code_verifier character varying(128) NOT NULL,
    binding_hash character varying(64) NOT NULL,
    purpose character varying(16) NOT NULL,
    user_id uuid,
    invite_token character varying(80),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT oidc_login_states_pkey PRIMARY KEY (state_hash),
    CONSTRAINT oidc_login_states_purpose_check CHECK (purpose IN ('sign_in', 'link')),
    CONSTRAINT oidc_login_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_oidc_login_states_expires_at ON public.oidc_login_states USING btree (expires_at);
