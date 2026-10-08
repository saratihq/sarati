import type { ReviewDetail } from "@/api/client";

type Blocking = NonNullable<ReviewDetail["merge_blocked_by_test"]>;

/** Why a protected merge is refused right now — the service's own answer — naming and linking the review whose test it is. */
export default function MergeBlockedNote({
  workflowId,
  reviewId,
  targetBranch,
  blocking,
}: {
  workflowId: string;
  reviewId: string;
  targetBranch: string;
  blocking: Blocking;
}) {
  const where =
    blocking.review_id === reviewId ? (
      "The latest conclusive test of these versions is failing"
    ) : blocking.review_id === null ? (
      "The latest conclusive test of these versions failed, run from a branch that has since been deleted"
    ) : (
      <>
        {"The latest conclusive test of these versions — on review "}
        <a
          href={`/workflows/${workflowId}/overview?${new URLSearchParams({
            branch: blocking.target_branch ?? targetBranch,
            review: blocking.review_id,
          }).toString()}`}
          className="underline"
          style={{ color: "inherit" }}
        >
          {blocking.title}
        </a>
        {` (${blocking.source_branch} → ${blocking.target_branch}) — is failing`}
      </>
    );
  return (
    <div
      className="text-[11px] py-1.5 px-2.5 rounded"
      style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
      data-testid="merge-blocked-note"
    >
      {where}
      {`, so merging into ${targetBranch} is blocked.`}
      {blocking.error ? ` It failed with: ${blocking.error}.` : ""}
      {" Commit a fix, or re-test once the cause is resolved."}
    </div>
  );
}
