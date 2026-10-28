-- 043 — single sign-on: the identities a person signs in with at an OpenID Connect provider, keyed by (issuer, subject),
-- the single-use state a browser sign-in holds between its start and its completion, and whether an account holds its
-- email (false when single sign-on made it from an address the provider did not confirm). One account holds an address,
-- in any letter case; an unconfirmed one claims and blocks nothing, so the unique index on email becomes a partial one.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT true NOT NULL;

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

-- Two accounts holding one address apart from letter case: the one already in lower case keeps it, else the oldest.
DO $$
DECLARE
  twin record;
BEGIN
  FOR twin IN
    SELECT id, email FROM (
      SELECT id, email,
             row_number() OVER (PARTITION BY lower(email)
                                ORDER BY (email = lower(email)) DESC, created_at NULLS LAST, id) AS rank
        FROM public.users WHERE email_verified
    ) ranked WHERE rank > 1
  LOOP
    UPDATE public.users SET email_verified = false WHERE id = twin.id;
    RAISE WARNING '% (%) shares its address with another account apart from letter case, so it no longer holds it: an invite to it goes to the other', twin.email, twin.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_confirmed_email ON public.users USING btree (lower((email)::text)) WHERE email_verified;

DROP INDEX IF EXISTS public.ix_users_email;
