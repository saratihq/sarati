-- 015 — pre-merge "Test this branch".

-- Review-test runs ARE runtime_runs (source='review_test'); this links them to
-- the review that spawned them. No new run table.
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS review_id uuid;

-- The review's latest pre-merge test result: verdict + field-level regression +
-- the tested head/target version ids (staleness key) + the two run ids. JSON,
-- nullable (no test yet). Read by the protected-branch merge gate.
ALTER TABLE workflow_reviews ADD COLUMN IF NOT EXISTS last_test json;
