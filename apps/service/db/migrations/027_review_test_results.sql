-- 027 — every pre-merge test result, kept by the two versions it tested.
--
-- A review held one test result, and the protected-merge gate read that slot.
-- A re-test, two tests at once, or deleting a branch (its reviews cascade away)
-- could erase the failing result the gate depended on. Results are now
-- appended here and outlive their review; the gate reads the latest decisive
-- result of the exact version pair. workflow_reviews.last_test stays as what
-- the review card shows. Existing last_test values are carried over once.

CREATE TABLE IF NOT EXISTS public.review_test_results (
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    review_id uuid,
    source_version_id uuid NOT NULL,
    target_version_id uuid NOT NULL,
    verdict character varying(10) NOT NULL,
    decisive boolean NOT NULL,
    tested_at timestamp with time zone NOT NULL,
    summary json NOT NULL,
    CONSTRAINT review_test_results_pkey PRIMARY KEY (id),
    CONSTRAINT review_test_results_workflow_id_fkey FOREIGN KEY (workflow_id)
        REFERENCES public.workflows(id) ON DELETE CASCADE,
    CONSTRAINT review_test_results_review_id_fkey FOREIGN KEY (review_id)
        REFERENCES public.workflow_reviews(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_review_test_results_versions
    ON public.review_test_results (workflow_id, source_version_id, target_version_id, tested_at DESC);

CREATE INDEX IF NOT EXISTS ix_review_test_results_review
    ON public.review_test_results (review_id);

INSERT INTO public.review_test_results
    (id, workflow_id, review_id, source_version_id, target_version_id, verdict, decisive, tested_at, summary)
SELECT gen_random_uuid(), r.workflow_id, r.id,
       (r.last_test->>'source_version_id')::uuid, (r.last_test->>'target_version_id')::uuid,
       r.last_test->>'verdict',
       r.last_test->>'verdict' = 'red' OR coalesce(r.last_test->'head'->>'status', '') <> 'error',
       (r.last_test->>'tested_at')::timestamptz, r.last_test
  FROM public.workflow_reviews r
 WHERE r.last_test IS NOT NULL
   AND r.last_test->>'source_version_id' IS NOT NULL
   AND r.last_test->>'target_version_id' IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM public.review_test_results t
        WHERE t.review_id = r.id AND t.tested_at = (r.last_test->>'tested_at')::timestamptz);
