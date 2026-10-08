-- 029 — an approval covers the version it saw: a merge into a protected branch needs an approval of the
-- source branch's CURRENT head, so a commit after approval needs approving again.
-- Older approvals record no version and so cover none — they are approved again after this upgrade.
-- Idempotent: db:migrate re-runs every file.

ALTER TABLE review_approvals ADD COLUMN IF NOT EXISTS source_version_id uuid;
