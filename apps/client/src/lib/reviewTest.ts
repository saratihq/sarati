import type { ReviewDetail, ReviewTestSummary } from "@/api/client";

/**
 * Whether a test result still describes the branches as they are — the service lets a red one block a
 * protected merge, from a review or the branch selector, only then; the card must not say "blocked" once either head has moved.
 */
export function testIsCurrent(
  test: Pick<ReviewTestSummary, "source_version_id" | "target_version_id">,
  detail: Pick<ReviewDetail, "source_head_version_id" | "target_head_version_id"> | null | undefined,
): boolean {
  return (
    !!detail &&
    test.source_version_id === detail.source_head_version_id &&
    test.target_version_id === detail.target_head_version_id
  );
}
