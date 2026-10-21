import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import type { BlockedStep, ReviewTestReadiness, ReviewTestSummary } from "@/api/client";
import type { EnvironmentSummary } from "@/api/environments";
import ReviewTestPanel from "@/components/ReviewTestPanel";
import { useOrgs } from "@/store/useOrgs";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getReviewTestReadiness: vi.fn(),
  testReviewBranch: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const getReviewTestReadiness = vi.mocked(api.getReviewTestReadiness);
const testReviewBranch = vi.mocked(api.testReviewBranch);
const clean: ReviewTestReadiness = { environment: null, blocked: [] };

beforeEach(() => {
  getReviewTestReadiness.mockReset();
  getReviewTestReadiness.mockResolvedValue(clean);
  testReviewBranch.mockReset();
  useOrgs.setState({ orgs: [], activeOrgId: null });
});

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
      sourceBranch="add-email"
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

describe("ReviewTestPanel — where a result stands for merging", () => {
  const result = (over: Partial<ReviewTestSummary>): ReviewTestSummary => ({ ...summary([]), ...over });
  const renderWith = (r: ReviewTestSummary, current: boolean, gate: { blocked: boolean } | null) =>
    render(
      <ReviewTestPanel
        workflowId="wf"
        reviewId="rev"
        sourceBranch="add-email"
        environments={null}
        result={r}
        onResult={vi.fn()}
        canRun
        current={current}
        gate={gate}
      />,
    );

  it("calls a run where the target failed too Inconclusive, and says an earlier failure still blocks", () => {
    renderWith(
      result({
        base: { run_id: "b", status: "error", error: "down" },
        head: { run_id: "h", status: "error", error: "down" },
      }),
      true,
      { blocked: true },
    );
    expect(screen.getByText("Inconclusive")).toBeInTheDocument();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
    expect(screen.getByTestId("test-standing")).toHaveTextContent("A failing conclusive test of these versions still blocks merging.");
  });

  it("says a failing result has been lifted when a newer passing test unblocked the merge", () => {
    renderWith(
      result({ verdict: "red", head: { run_id: "h", status: "error", error: "boom" } }),
      true,
      { blocked: false },
    );
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByTestId("test-standing")).toHaveTextContent("has lifted this");
  });

  it("says a result tested earlier versions once either branch has moved on", () => {
    renderWith(result({ verdict: "red", head: { run_id: "h", status: "error", error: "boom" } }), false, { blocked: false });
    expect(screen.getByTestId("test-standing")).toHaveTextContent("This tested earlier versions");
  });

  it("adds nothing when the result is current and decides the merge as shown", () => {
    renderWith(result({ verdict: "red", head: { run_id: "h", status: "error", error: "boom" } }), true, { blocked: true });
    expect(screen.queryByTestId("test-standing")).not.toBeInTheDocument();
  });
});


describe("ReviewTestPanel — what the test would refuse, before it runs", () => {
  const blocked = (over: Partial<BlockedStep>): BlockedStep => ({
    node_id: "send_report",
    node_name: "Email me the report",
    app: "gmail",
    reason: "none",
    message: 'Step "Email me the report" has no gmail account to run as — connect one',
    ...over,
  });
  const production = { id: "env-prod", name: "production", is_prod: true } as unknown as EnvironmentSummary;
  const renderRunnable = () =>
    render(
      <ReviewTestPanel
        workflowId="wf"
        reviewId="rev"
        sourceBranch="add-email"
        environments={[production]}
        result={null}
        onResult={vi.fn()}
        canRun
      />,
    );

  it("names nothing when every step has an account to run as", async () => {
    renderRunnable();
    expect(await screen.findByRole("button", { name: "Test this branch" })).toBeEnabled();
    expect(getReviewTestReadiness).toHaveBeenCalledWith("wf", "rev", undefined);
    expect(screen.queryByTestId("test-readiness")).not.toBeInTheDocument();
  });

  it("says, in the run's own words, a step with no account, and where to connect one", async () => {
    getReviewTestReadiness.mockResolvedValue({ environment: null, blocked: [blocked({})] });
    renderRunnable();
    const box = await screen.findByTestId("test-readiness");
    expect(box).toHaveTextContent('Step "Email me the report" has no gmail account to run as — connect one');
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/integrations");
    expect(screen.queryByRole("link", { name: /Open add-email/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeEnabled();
  });

  it("sends a step with several accounts, or a stale one, to the branch to pick", async () => {
    getReviewTestReadiness.mockResolvedValue({
      environment: null,
      blocked: [
        blocked({
          reason: "several",
          message: 'Step "Email me the report" has no gmail account chosen and you have 2 active gmail accounts — pick one on the step',
        }),
      ],
    });
    renderRunnable();
    expect(await screen.findByTestId("test-readiness")).toHaveTextContent("you have 2 active gmail accounts — pick one on the step");
    expect(screen.getByRole("link", { name: "Open add-email to pick its account" })).toHaveAttribute(
      "href",
      "/workflows/wf/edit?branch=add-email",
    );
  });

  it("sends a step whose chosen account isn't active to its branch to pick another", async () => {
    getReviewTestReadiness.mockResolvedValue({
      environment: null,
      blocked: [
        blocked({
          reason: "inactive",
          message:
            "Step \"Email me the report\" runs as a gmail account that isn't active — pick another of your gmail accounts on the step",
        }),
      ],
    });
    renderRunnable();
    expect(await screen.findByTestId("test-readiness")).toHaveTextContent("isn't active — pick another of your gmail accounts");
    expect(screen.getByRole("link", { name: "Open add-email to pick its account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Integrations" })).not.toBeInTheDocument();
  });

  it("asks again for the picked environment, names its empty slot, and holds the run", async () => {
    renderRunnable();
    await screen.findByRole("button", { name: "Test this branch" });
    getReviewTestReadiness.mockResolvedValue({
      environment: { id: "env-prod", name: "production" },
      blocked: [
        blocked({
          reason: "empty_slot",
          message:
            'production has no gmail account assigned, so "Email me the report" can\'t run there — an owner assigns one under Integrations → Environments',
        }),
      ],
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "env-prod" } });

    const box = await screen.findByTestId("test-readiness");
    expect(getReviewTestReadiness).toHaveBeenLastCalledWith("wf", "rev", "env-prod");
    expect(box).toHaveTextContent(/^production has no gmail account assigned/);
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeDisabled();
  });

  it("sends a step whose chosen account is for another app to the branch to pick one", async () => {
    getReviewTestReadiness.mockResolvedValue({
      environment: null,
      blocked: [
        blocked({
          reason: "wrong_app",
          message:
            'Step "Email me the report" runs as an account for slack, not gmail — pick one of your gmail accounts on the step',
        }),
      ],
    });
    renderRunnable();
    expect(await screen.findByTestId("test-readiness")).toHaveTextContent("runs as an account for slack, not gmail");
    expect(screen.getByRole("link", { name: "Open add-email to pick its account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Integrations" })).not.toBeInTheDocument();
  });

  it("names an environment whose account isn't active, sends it to Integrations, and holds the run", async () => {
    renderRunnable();
    await screen.findByRole("button", { name: "Test this branch" });
    getReviewTestReadiness.mockResolvedValue({
      environment: { id: "env-prod", name: "production" },
      blocked: [
        blocked({
          reason: "inactive_slot",
          message:
            'production\'s gmail account isn\'t active, so "Email me the report" can\'t run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments',
        }),
      ],
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "env-prod" } });

    expect(await screen.findByTestId("test-readiness")).toHaveTextContent(/^production's gmail account isn't active/);
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/integrations");
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeDisabled();
  });

  it("sends a step holding an own-credentials account it can't run on to pick a one-click one, or connect one", async () => {
    getReviewTestReadiness.mockResolvedValue({
      environment: null,
      blocked: [
        blocked({
          node_name: "Remind me",
          app: "slack",
          reason: "needs_managed",
          message:
            'Step "Remind me" runs as an account that uses its own credentials, and it runs only on a one-click (managed) slack account — pick one on the step, or connect one under Integrations',
        }),
      ],
    });
    renderRunnable();
    expect(await screen.findByTestId("test-readiness")).toHaveTextContent("runs only on a one-click (managed) slack account");
    expect(screen.getByRole("link", { name: "Open add-email to pick its account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/integrations");
  });

  it.each([
    ["wrong_app_slot", 'production\'s gmail account is for slack, so "Email me the report" can\'t run there — an owner assigns a gmail account under Integrations → Environments'],
    [
      "needs_managed_slot",
      'production\'s gmail account uses its own credentials, and "Email me the report" runs only on a one-click (managed) one, so it can\'t run there — an owner assigns a one-click gmail account under Integrations → Environments',
    ],
  ] as const)("names an environment whose account can't run a step (%s), sends it to Integrations, and holds the run", async (reason, message) => {
    renderRunnable();
    await screen.findByRole("button", { name: "Test this branch" });
    getReviewTestReadiness.mockResolvedValue({
      environment: { id: "env-prod", name: "production" },
      blocked: [blocked({ reason, message })],
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "env-prod" } });

    expect(await screen.findByTestId("test-readiness")).toHaveTextContent(message);
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/integrations");
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeDisabled();
  });

  it("asks again once the window has focus back, so a slot assigned elsewhere frees the run", async () => {
    getReviewTestReadiness.mockResolvedValue({
      environment: { id: "env-prod", name: "production" },
      blocked: [
        blocked({
          reason: "empty_slot",
          message:
            'production has no gmail account assigned, so "Email me the report" can\'t run there — an owner assigns one under Integrations → Environments',
        }),
      ],
    });
    renderRunnable();
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "env-prod" } });
    await screen.findByTestId("test-readiness");
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeDisabled();

    getReviewTestReadiness.mockResolvedValue({ environment: { id: "env-prod", name: "production" }, blocked: [] });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(screen.queryByTestId("test-readiness")).not.toBeInTheDocument());
    expect(getReviewTestReadiness).toHaveBeenLastCalledWith("wf", "rev", "env-prod");
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeEnabled();
  });

  it("asks again when the branch under review moves on", async () => {
    getReviewTestReadiness.mockResolvedValue({ environment: null, blocked: [blocked({ reason: "several" })] });
    const panel = (sourceHead: string) => (
      <ReviewTestPanel
        workflowId="wf"
        reviewId="rev"
        sourceBranch="add-email"
        sourceHeadVersionId={sourceHead}
        environments={[production]}
        result={null}
        onResult={vi.fn()}
        canRun
      />
    );
    const { rerender } = render(panel("v-1"));
    await screen.findByTestId("test-readiness");

    getReviewTestReadiness.mockResolvedValue(clean);
    rerender(panel("v-2"));

    await waitFor(() => expect(screen.queryByTestId("test-readiness")).not.toBeInTheDocument());
    expect(getReviewTestReadiness).toHaveBeenCalledTimes(2);
  });

  it("says when it couldn't check, and leaves the run available", async () => {
    getReviewTestReadiness.mockRejectedValue(new Error("network down"));
    renderRunnable();
    expect(await screen.findByText(/Couldn't check this branch's accounts before running \(network down\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test this branch" })).toBeEnabled();
  });
});

describe("ReviewTestPanel — an environment takes the right to promote there", () => {
  const production = { id: "env-prod", name: "production", is_prod: true } as unknown as EnvironmentSummary;
  const inTeamAs = (role: "member" | "admin") =>
    useOrgs.setState({ orgs: [{ id: "o1", name: "Team", is_personal: false, role }], activeOrgId: "o1" });
  const renderPanel = () =>
    render(
      <ReviewTestPanel
        workflowId="wf"
        reviewId="rev"
        sourceBranch="add-email"
        environments={[production]}
        result={null}
        onResult={vi.fn()}
        canRun
      />,
    );
  const runOn = async (value: string) => {
    fireEvent.change(await screen.findByRole("combobox"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Test this branch" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run test" }));
    await waitFor(() => expect(testReviewBranch).toHaveBeenCalledTimes(1));
  };

  it("offers a member only Default, says why, and never sends an environment", async () => {
    inTeamAs("member");
    testReviewBranch.mockResolvedValue(summary([]));
    renderPanel();

    expect(await screen.findByRole("option", { name: "production" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveAccessibleDescription(
      "Only owners and admins can test a branch under an environment, the same as promoting to it — test it on Default (your connections).",
    );
    await runOn("env-prod");

    expect(testReviewBranch).toHaveBeenCalledWith("wf", "rev", {});
    expect(getReviewTestReadiness).not.toHaveBeenCalledWith("wf", "rev", "env-prod");
  });

  it("offers an admin every environment and runs under the one picked", async () => {
    inTeamAs("admin");
    testReviewBranch.mockResolvedValue({ ...summary([]), environment_id: "env-prod" });
    renderPanel();

    expect(await screen.findByRole("option", { name: "production" })).toBeEnabled();
    expect(screen.queryByTestId("test-env-gate")).not.toBeInTheDocument();
    await runOn("env-prod");

    expect(testReviewBranch).toHaveBeenCalledWith("wf", "rev", { environment_id: "env-prod" });
  });
});
