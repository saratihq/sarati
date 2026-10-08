import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import * as environments from "@/api/environments";
import ActivityFeed from "@/components/ActivityFeed";
import { toast } from "@/lib/toast";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listVersions: vi.fn(),
  listReviews: vi.fn(),
  listBranches: vi.fn(),
  getReview: vi.fn(),
  mergeBranch: vi.fn(),
  updateBranch: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
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

describe("ActivityFeed promote menu", () => {
  it("keeps production and uat main-only off main even when the environments list can't load", async () => {
    vi.mocked(api.listVersions).mockResolvedValue({
      workflow_id: "wf",
      env_pointers: [],
      versions: [
        { id: "v-lane", version_number: 1, workflow_json: {}, tags: ["latest"], parent_id: "v-main", branch_name: "lane" },
      ],
    });
    vi.mocked(api.listReviews).mockResolvedValue({ workflow_id: "wf", reviews: [] });
    vi.mocked(api.listBranches).mockResolvedValue({ workflow_id: "wf", branches: [] });
    vi.mocked(environments.listEnvironments).mockRejectedValue(new Error("environments are down"));
    const user = userEvent.setup();
    render(<ActivityFeed workflowId="wf" branch="lane" refreshKey={0} onChanged={vi.fn()} onMerged={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Promote" }));

    expect(screen.getByRole("button", { name: /Promote to production/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Promote to uat/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Promote to staging/ })).toBeEnabled();
  });
});

describe("ActivityFeed merge into main", () => {
  it("says the branch is deleted after the merge, and confirms it when it was", async () => {
    vi.mocked(api.listVersions).mockResolvedValue({
      workflow_id: "wf",
      env_pointers: [],
      versions: [
        { id: "v-lane", version_number: 1, workflow_json: {}, tags: ["latest"], parent_id: "v-main", branch_name: "lane" },
      ],
    });
    vi.mocked(api.listReviews).mockResolvedValue({ workflow_id: "wf", reviews: [] });
    vi.mocked(api.listBranches).mockResolvedValue({ workflow_id: "wf", branches: [] });
    vi.mocked(api.mergeBranch).mockResolvedValue({
      status: "merged",
      merged_version_id: "v-merged",
      cleaned_up: { branch_deleted: "lane" },
    });
    const onMerged = vi.fn();
    const user = userEvent.setup();
    render(<ActivityFeed workflowId="wf" branch="lane" refreshKey={0} onChanged={vi.fn()} onMerged={onMerged} />);

    await user.click(await screen.findByRole("button", { name: "Merge into main" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent('Then "lane" is deleted along with its reviews');
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await vi.waitFor(() => expect(onMerged).toHaveBeenCalledWith("main"));
    expect(toast.success).toHaveBeenCalledWith("Branch merged", '"lane" merged into "main" and was deleted');
  });
});

describe("ActivityFeed protected merges", () => {
  it("says an approval from before the latest changes must be given again, and offers no merge until then", async () => {
    vi.mocked(api.getReview).mockResolvedValue({
      ...review,
      status: "approved",
      comments: [],
      approvals: [],
      last_test: null,
      source_head_version_id: "v-lane-2",
      target_head_version_id: "v-main",
      up_to_date: false,
      target_protected: true,
      approval_current: false,
      merge_blocked_by_test: null,
    });
    render(
      <ActivityFeed workflowId="wf" branch="main" refreshKey={0} onChanged={vi.fn()} onMerged={vi.fn()} initialReviewId="r1" />,
    );

    expect(await screen.findByText(/Approved before the latest changes to lane/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("offers to update the branch from its target when a protected merge would need conflicts resolved", async () => {
    vi.mocked(api.listVersions).mockResolvedValue({
      workflow_id: "wf",
      env_pointers: [],
      versions: [
        { id: "v-lane", version_number: 1, workflow_json: {}, tags: ["latest"], parent_id: "v-main", branch_name: "lane" },
      ],
    });
    vi.mocked(api.listReviews).mockResolvedValue({ workflow_id: "wf", reviews: [] });
    vi.mocked(api.listBranches).mockResolvedValue({ workflow_id: "wf", branches: [] });
    vi.mocked(api.mergeBranch).mockRejectedValue(
      new api.ApiError("Branch 'main' is protected, so conflicts can't be resolved while merging into it.", 409, "protected_merge_conflicts"),
    );
    vi.mocked(api.updateBranch).mockResolvedValue({ status: "merged", merged_version_id: "v-lane-2" });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<ActivityFeed workflowId="wf" branch="lane" refreshKey={0} onChanged={onChanged} onMerged={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Merge into main" }));
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.click(await screen.findByRole("button", { name: "Update lane from main" }));

    await vi.waitFor(() => expect(api.updateBranch).toHaveBeenCalledWith("wf", "lane", "main"));
    expect(toast.success).toHaveBeenCalledWith(
      "Branch updated",
      '"lane" has "main"\'s changes — test it again and get it approved before merging',
    );
    expect(onChanged).toHaveBeenCalled();
  });
});
