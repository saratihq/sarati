-- 021 — record a step's non-fatal reference warnings.
--
-- A FULL-STRING `{{ref}}` (the whole field is one reference) that resolves to
-- nothing is almost always a wrong path, and used to yield an empty value
-- silently. The interpreter records those refs here so run history surfaces the
-- empty field. Fail-open: the step still runs, and this never fails it.
--
-- A json array of human sentences, or NULL when the step had none. `json`, not
-- jsonb, to match the rest of the runtime tables.

ALTER TABLE public.runtime_run_steps
    ADD COLUMN IF NOT EXISTS warnings json;
