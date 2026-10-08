import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import * as environments from "@/api/environments";
import ActivityFeed from "@/components/ActivityFeed";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listVersions: vi.fn(),
  listReviews: vi.fn(),
  listBranches: vi.fn(),
  getReview: vi.fn(),
}));
vi.mock("@/api/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof environments>()),
  listEnvironments: vi.fn(),
}));

const review: api.ReviewSummary = {
  id: "r1",
  title: "lane → main",
  status: "open",
  source_branch: "lane",
  target_branch: "main",
  created_at: "2026-10-08T09:00:00.000Z",
  updated_at: "2026-10-08T09:00:00.000Z",
  comment_count: 0,
  approval_count: 1,
};

const failing: api.ReviewTestSummary = {
  verdict: "red",
  tested_at: "2026-10-08T10:00:00.000Z",
  environment_id: null,
  source_version_id: "v-lane",
  target_version_id: "v-main",
  base: { run_id: "base-run", status: "completed", error: null },
  head: { run_id: "head-run", status: "error", error: "boom" },
  regression: { changed: [], added: [], removed: [] },
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.listVersions).mockResolvedValue({ workflow_id: "wf", versions: [], env_pointers: [] } as never);
  vi.mocked(api.listReviews).mockResolvedValue({ workflow_id: "wf", reviews: [review] });
  vi.mocked(environments.listEnvironments).mockResolvedValue([] as never);
});

describe("ActivityFeed review card", () => {
  it("reads whether a review is still open from the same answer as its merge gate", async () => {
    // The list still says open; the detail — the gate's own answer — says it was closed since.
    vi.mocked(api.getReview).mockResolvedValue({
      ...review,
      status: "closed",
      comments: [],
      approvals: [],
      last_test: failing,
      source_head_version_id: "v-lane",
      target_head_version_id: "v-main",
      up_to_date: false,
      target_protected: true,
      merge_blocked_by_test: null,
    });
    render(
      <ActivityFeed
        workflowId="wf"
        branch="main"
        refreshKey={0}
        onChanged={vi.fn()}
        onMerged={vi.fn()}
        initialReviewId="r1"
      />,
    );

    expect(await screen.findByText("Failing")).toBeInTheDocument();
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.queryByText(/no longer blocks merging/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test this branch" })).not.toBeInTheDocument();
  });
});
