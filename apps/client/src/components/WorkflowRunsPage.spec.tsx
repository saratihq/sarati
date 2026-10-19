import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import WorkflowRunsPage from "@/components/WorkflowRunsPage";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/WorkflowDetail", () => ({
  useWorkflowContext: () => ({ workflowId: "wf-1", workflowName: "Notify the channel" }),
}));

const listRuns = vi.mocked(api.listRuns);
const getRun = vi.mocked(api.getRun);

const run = (over: Partial<api.RunSummary>): api.RunSummary => ({
  run_id: "r",
  workflow_id: "wf-1",
  workflow_name: "Notify the channel",
  status: "completed",
  started_at: "2026-09-30T09:00:00.000Z",
  finished_at: "2026-09-30T09:00:01.000Z",
  duration_ms: 1000,
  error: null,
  source: "manual",
  ...over,
});

describe("WorkflowRunsPage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The statuses are the service's own words; `error` used to fall through as a grey, lower-case "error".
  it("names each status the service reports, and a failed run reads Failed in the failure colour", async () => {
    listRuns.mockResolvedValue({
      runs: [
        run({ run_id: "r-error", status: "error", error: "http.send_request failed: HTTP 404" }),
        run({ run_id: "r-cancelled", status: "cancelled" }),
        run({ run_id: "r-done", status: "completed" }),
      ],
    });
    render(<WorkflowRunsPage />);

    const failed = await screen.findByText("Failed");
    expect(failed).toHaveStyle({ color: "var(--orchestr-danger)" });
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("error")).not.toBeInTheDocument();
    expect(screen.queryByText("cancelled")).not.toBeInTheDocument();
  });

  it("a dry run is listed as one, never as a run that completed", async () => {
    listRuns.mockResolvedValue({
      runs: [run({ run_id: "r-dry", dry_run: true }), run({ run_id: "r-live", dry_run: false })],
    });
    render(<WorkflowRunsPage />);

    const rows = await screen.findAllByRole("button", { expanded: false });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Dry run/),
      expect.stringMatching(/^Completed/),
    ]);
  });

  // The step outputs are a dry run's own, as a live instance recorded them.
  it("an opened dry run says what it did with each step it did not carry out", async () => {
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-dry", dry_run: true })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-dry", dry_run: true }),
      steps: [
        {
          node_id: "pause",
          status: "completed",
          output: { dry_run: true, withheld: "delay", skipped_delay_ms: 172_800_000 },
          output_preview: '{"dry_run":true,"withheld":"delay","skipped_delay_ms":172800000}',
        },
        {
          node_id: "approve",
          status: "completed",
          output: { dry_run: true, withheld: "wait", skipped: "wait-for-event (dry run)" },
          output_preview: '{"dry_run":true,"withheld":"wait","skipped":"wait-for-event (dry run)"}',
        },
        { node_id: "read", status: "completed", output: { status: 200 }, output_preview: '{"status":200}' },
      ],
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    expect(await screen.findByText(/^A dry run\. Reads run for real\./)).toBeInTheDocument();
    expect(screen.getAllByTestId("run-step-withheld").map((p) => p.textContent)).toEqual([
      "Wait skipped — 48h 0m",
      "Not waited for — a dry run does not pause for an event",
    ]);
    // A step that ran shows its output; a withheld one shows the sentence instead of its marker.
    expect(screen.getByText('{"status":200}')).toBeInTheDocument();
    expect(screen.queryByText(/"withheld"/)).not.toBeInTheDocument();
  });

  it("an opened waiting run says what it waits for: a Wait step its wake time, an approval the inbox", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
    listRuns.mockResolvedValue({
      runs: [run({ run_id: "r-sleep", status: "waiting" }), run({ run_id: "r-ask", status: "waiting" })],
    });
    getRun.mockImplementation(async (runId) => ({
      ...run({ run_id: runId, status: "waiting" }),
      steps: [],
      waiting:
        runId === "r-sleep"
          ? { kind: "timer", until: "2026-10-12T09:30:00.000Z" }
          : { kind: "event", until: "2026-10-09T10:00:00.000Z" },
    }));
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);
    const [sleeping, asking] = await screen.findAllByRole("button", { expanded: false });

    await user.click(sleeping!);
    expect((await screen.findByTestId("run-waiting")).textContent).toBe(
      "Waiting until Oct 12, 9:30 AM. Paused on a Wait step — it resumes on its own.",
    );
    expect(screen.queryByRole("link", { name: /approvals inbox/ })).not.toBeInTheDocument();

    await user.click(asking!);
    expect(await screen.findByRole("link", { name: "open the approvals inbox" })).toHaveAttribute(
      "href",
      "/approvals",
    );
    expect(screen.getByTestId("run-waiting").textContent).toBe(
      "Waiting for a decision. Paused on an approval step — open the approvals inbox.",
    );
  });

  it("a run parked on a timer and an approval at once says, on each step, what that step waits for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T09:00:00.000Z"));
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-both", status: "waiting" })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-both", status: "waiting" }),
      steps: [
        { node_id: "pause", status: "running", waiting: { kind: "timer", until: "2026-10-12T09:30:00.000Z" } },
        { node_id: "approve", status: "running", waiting: { kind: "event", until: "2026-10-09T10:00:00.000Z" } },
        { node_id: "fetch", status: "completed", waiting: null },
      ],
      waiting: { kind: "event", until: "2026-10-09T10:00:00.000Z" },
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    expect((await screen.findByTestId("run-waiting")).textContent).toBe(
      "Waiting for a decision. Paused on an approval step — open the approvals inbox.",
    );
    expect(screen.getAllByTestId("run-step-waiting").map((line) => line.textContent)).toEqual([
      "Waiting until Oct 12, 9:30 AM",
      "Waiting for a decision",
    ]);
  });

  it("a decision made but not yet taken reads who made it, never the inbox that no longer lists it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T09:00:00.000Z"));
    const decided = { kind: "decided" as const, until: "2026-10-09T10:00:00.000Z", decided_by: { id: "u-2", name: "Bo", email: null } };
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-decided", status: "waiting" })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-decided", status: "waiting" }),
      steps: [{ node_id: "approve", status: "running", waiting: decided }],
      waiting: decided,
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    expect((await screen.findByTestId("run-waiting")).textContent).toBe(
      "Decided by Bo — the run will continue shortly. ",
    );
    expect(screen.getAllByTestId("run-step-waiting").map((line) => line.textContent)).toEqual([
      "Decided by Bo — the run will continue shortly",
    ]);
    expect(screen.queryByRole("link", { name: /approvals inbox/ })).not.toBeInTheDocument();
  });

  it("a run whose approvals different members answered names each one on the step they answered", async () => {
    const decidedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-two" })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-two" }),
      decided_by: { id: "u-bo", name: "Bo Member", email: "bo@example.com" },
      decided_at: decidedAt,
      steps: [
        {
          node_id: "legal",
          status: "completed",
          decided_by: { id: "u-bo", name: "Bo Member", email: "bo@example.com" },
          decided_at: decidedAt,
        },
        {
          node_id: "finance",
          status: "completed",
          decided_by: { id: "u-ada", name: null, email: "ada@example.com" },
          decided_at: decidedAt,
        },
        { node_id: "audit", status: "completed", decided_by: { id: "u-gone", name: null, email: null } },
        { node_id: "notify", status: "completed", decided_by: null, decided_at: null },
      ],
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    const lines = (await screen.findAllByTestId("run-step-decider")).map((line) => line.textContent);
    expect(lines).toEqual([
      "Resolved by Bo Member · 5m ago",
      "Resolved by ada@example.com · 5m ago",
      "Resolved by a teammate",
    ]);
    expect(screen.getAllByText(/^Resolved by/)).toHaveLength(3);
    expect(screen.queryByTestId("run-decider")).not.toBeInTheDocument();
  });

  it("a run decided before steps kept their own deciders names its last decider on the run", async () => {
    const bo = { id: "u-bo", name: "Bo Member", email: "bo@example.com" };
    const decidedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-old" })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-old" }),
      decided_by: bo,
      decided_at: decidedAt,
      unattributed_decision: { decided_by: bo, decided_at: decidedAt },
      steps: [
        { node_id: "legal", status: "completed", decided_by: null, decided_at: null },
        { node_id: "finance", status: "completed", decided_by: null, decided_at: null },
      ],
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    expect((await screen.findByTestId("run-decider")).textContent).toBe("Resolved by Bo Member · 2h ago");
    expect(screen.queryAllByTestId("run-step-decider")).toHaveLength(0);
  });

  it("a decision no step holds is still named on the run beside the steps that are credited", async () => {
    const decidedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-back" })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-back" }),
      decided_by: null,
      decided_at: null,
      unattributed_decision: { decided_by: { id: "u-ada", name: "Ada Owner", email: null }, decided_at: decidedAt },
      steps: [
        {
          node_id: "legal",
          status: "completed",
          decided_by: { id: "u-bo", name: "Bo Member", email: null },
          decided_at: decidedAt,
        },
        { node_id: "finance", status: "completed", decided_by: null, decided_at: null },
      ],
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    expect((await screen.findAllByTestId("run-step-decider")).map((l) => l.textContent)).toEqual([
      "Resolved by Bo Member · 5m ago",
    ]);
    expect(screen.getByTestId("run-decider").textContent).toBe("Resolved by Ada Owner · 5m ago");
  });

  it("a real run's step that returns an object shaped like a marker is shown as its output", async () => {
    listRuns.mockResolvedValue({ runs: [run({ run_id: "r-live" })] });
    getRun.mockResolvedValue({
      ...run({ run_id: "r-live" }),
      steps: [
        {
          node_id: "validate",
          status: "completed",
          output: { dry_run: true, accepted: 3 },
          output_preview: '{"dry_run":true,"accepted":3}',
        },
      ],
    });
    const user = userEvent.setup();
    render(<WorkflowRunsPage />);

    await user.click((await screen.findAllByRole("button", { expanded: false }))[0]!);

    expect(await screen.findByText('{"dry_run":true,"accepted":3}')).toBeInTheDocument();
    expect(screen.queryByTestId("run-step-withheld")).not.toBeInTheDocument();
  });
});
