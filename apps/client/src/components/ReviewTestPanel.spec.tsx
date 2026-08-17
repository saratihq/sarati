import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewTestSummary } from "@/api/client";
import ReviewTestPanel from "@/components/ReviewTestPanel";

const summary = (changed: ReviewTestSummary["regression"]["changed"]): ReviewTestSummary => ({
  verdict: "green",
  tested_at: new Date().toISOString(),
  environment_id: null,
  source_version_id: "v-head",
  target_version_id: "v-base",
  base: { run_id: "11111111-2222", status: "completed", error: null },
  head: { run_id: "33333333-4444", status: "completed", error: null },
  regression: { changed, added: [], removed: [] },
});

const renderPanel = (result: ReviewTestSummary) =>
  render(
    <ReviewTestPanel
      workflowId="wf"
      reviewId="rev"
      environments={null}
      result={result}
      onResult={vi.fn()}
      canRun={false}
    />,
  );

describe("ReviewTestPanel output regression", () => {
  it("renders a collapsed array range as ONE row stating how many entries went", () => {
    renderPanel(
      summary([
        { node_id: "fetch_stories", path: "count", before: 45, after: 7 },
        { node_id: "fetch_stories", path: "stories[7…44]", before: [{ id: 7 }], after: null, count: 38 },
      ]),
    );

    expect(screen.getByText("stories[7…44]")).toBeInTheDocument();
    expect(screen.getByText("38 entries removed")).toBeInTheDocument();
    // The one line a reviewer needs is still there, and nothing renders a per-index row.
    expect(screen.getByText("count")).toBeInTheDocument();
    expect(screen.queryByText("stories[8]")).not.toBeInTheDocument();
  });

  it("still shows before → after values for an ordinary field change", () => {
    renderPanel(summary([{ node_id: "post", path: "body.text", before: "old", after: "new" }]));
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });
});
