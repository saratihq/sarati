import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MergeBlockedNote from "@/components/MergeBlockedNote";

const blocking = {
  review_id: "other",
  title: "Raise the limit",
  source_branch: "fork",
  target_branch: "main",
  error: "boom",
  tested_at: "2026-10-08T10:00:00.000Z",
};

describe("MergeBlockedNote", () => {
  it("names and links the review whose test blocks, with its own branches and what failed", () => {
    render(<MergeBlockedNote workflowId="wf" reviewId="this" targetBranch="main" blocking={blocking} />);
    const link = screen.getByRole("link", { name: "Raise the limit" });
    expect(link).toHaveAttribute("href", "/workflows/wf/overview?branch=main&review=other");
    expect(screen.getByTestId("merge-blocked-note")).toHaveTextContent(
      "on review Raise the limit (fork → main) — is failing, so merging into main is blocked. It failed with: boom.",
    );
  });

  it("speaks of this review's own test without a link", () => {
    render(
      <MergeBlockedNote workflowId="wf" reviewId="other" targetBranch="main" blocking={{ ...blocking, error: null }} />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTestId("merge-blocked-note")).toHaveTextContent(
      "The latest conclusive test of these versions is failing, so merging into main is blocked. Commit a fix",
    );
  });

  it("says the test ran from a branch since deleted when its review is gone", () => {
    render(
      <MergeBlockedNote
        workflowId="wf"
        reviewId="this"
        targetBranch="main"
        blocking={{ ...blocking, review_id: null, title: null, source_branch: null, target_branch: null }}
      />,
    );
    expect(screen.getByTestId("merge-blocked-note")).toHaveTextContent("run from a branch that has since been deleted");
  });
});
