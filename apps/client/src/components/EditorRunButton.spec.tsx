import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import EditorRunButton from "@/components/EditorRunButton";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  runWorkflowIr: vi.fn(),
  getRun: vi.fn(),
}));
vi.mock("@/lib/workflow-validation", () => ({ useMissingRequired: () => [] }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const runWorkflowIr = vi.mocked(api.runWorkflowIr);
const getRun = vi.mocked(api.getRun);

const DRAFT = {
  name: "Notify the channel",
  nodes: [
    { id: "trigger", name: "Trigger", node_type: "orchestr:trigger", parameters: {} },
    { id: "approve", name: "Ask first", node_type: "orchestr:wait_for_event", parameters: {} },
    { id: "post", name: "Post the summary", node_type: "http.send_request", parameters: {} },
  ],
  edges: [],
};

const watched = (over: Partial<api.RunDetail>): api.RunDetail => ({
  run_id: "r-1",
  workflow_id: "wf-1",
  workflow_name: "Notify the channel",
  status: "running",
  started_at: null,
  finished_at: null,
  duration_ms: null,
  error: null,
  source: "manual",
  steps: [],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
  useWorkflow.setState({ workflowJson: DRAFT, workflowId: "wf-1" });
  // A draft parked on an approval: the sync call stays open, so only the watcher sees what happens.
  runWorkflowIr.mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  vi.useRealTimers();
});

async function startAndWatchOnce() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<EditorRunButton />);
  await user.click(screen.getByRole("button", { name: "Run" }));
  await act(() => vi.advanceTimersByTimeAsync(3100));
}

describe("EditorRunButton watching a run whose call is still open", () => {
  // The service says `error`, never `failed`: watching for the wrong word left the panel on "Running…".
  it("a run that ends in error stops being watched and shows why it failed", async () => {
    getRun.mockResolvedValue(watched({ status: "error", error: "http.send_request failed: HTTP 500" }));
    await startAndWatchOnce();

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("http.send_request failed: HTTP 500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();

    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("a cancelled run reads Cancelled, not Failed", async () => {
    getRun.mockResolvedValue(watched({ status: "cancelled" }));
    await startAndWatchOnce();

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("the open call answering that the run was cancelled reads the same", async () => {
    runWorkflowIr.mockRejectedValue(
      new api.ApiError("Run 0d5f0c1e was cancelled", 409, "run_cancelled"),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EditorRunButton />);
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("a run parked on an approval says it is waiting, and keeps being watched", async () => {
    getRun.mockResolvedValue(
      watched({ status: "waiting", waiting: { kind: "event", until: "2026-10-09T10:00:00.000Z" } }),
    );
    await startAndWatchOnce();

    expect(screen.getByText("Waiting for a decision")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "open the approvals inbox" })).toHaveAttribute("href", "/approvals");
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  // A Wait step is not in the approvals inbox: pointing there sent people to a page that never listed the run.
  it("a run paused on a Wait step says when it wakes, with no inbox and no decision", async () => {
    getRun.mockResolvedValue(
      watched({ status: "waiting", waiting: { kind: "timer", until: "2026-10-12T09:30:00.000Z" } }),
    );
    await startAndWatchOnce();

    expect(screen.getByText("Waiting until Oct 12, 9:30 AM")).toBeInTheDocument();
    expect(screen.getByText("Paused on a Wait step — it resumes on its own.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /approvals inbox/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/decision/)).not.toBeInTheDocument();
  });

  // The service refuses an event to it as "was due at <time>"; the panel must not still promise a time gone by.
  it("a run whose wake time has passed says it was due then, not that it is waiting until then", async () => {
    getRun.mockResolvedValue(
      watched({ status: "waiting", waiting: { kind: "timer", until: "2026-10-09T09:30:00.000Z" } }),
    );
    await startAndWatchOnce();

    expect(screen.getByText("Was due at Oct 9, 9:30 AM")).toBeInTheDocument();
    expect(screen.queryByText(/Waiting until/)).not.toBeInTheDocument();
    expect(screen.getByText("Paused on a Wait step — it resumes on its own.")).toBeInTheDocument();
  });

  it("a run that wakes from its wait reads as running again", async () => {
    getRun
      .mockResolvedValueOnce(watched({ status: "waiting", waiting: { kind: "timer", until: "2026-10-12T09:30:00.000Z" } }))
      .mockResolvedValue(watched({ status: "running" }));
    await startAndWatchOnce();
    expect(screen.getByText("Waiting until Oct 12, 9:30 AM")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(screen.queryByText(/^Waiting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Paused on/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Running…")).toHaveLength(2);
  });

  it("the answer to a run the watcher already settled never overwrites the run started after it", async () => {
    let answerFirst: (result: api.RunIrResult) => void = () => undefined;
    runWorkflowIr
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ run_id: "r-2", outputs: { post: { second: true } } });
    getRun.mockResolvedValue(watched({ status: "cancelled" }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EditorRunButton />);

    await user.click(screen.getByRole("button", { name: "Run" }));
    await act(() => vi.advanceTimersByTimeAsync(3100));
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Completed")).toBeInTheDocument();

    await act(async () => answerFirst({ run_id: "r-1", outputs: { post: { first: true } } }));
    expect(screen.getByText(/"second": true/)).toBeInTheDocument();
    expect(screen.queryByText(/"first": true/)).not.toBeInTheDocument();
  });
});

describe("EditorRunButton dry run", () => {
  // The trace is a dry run's own answer, as a live instance returned it for this shape of draft.
  it("asks for a dry run, and says what each withheld step would have done", async () => {
    runWorkflowIr.mockResolvedValue({
      run_id: "r-dry",
      outputs: { trigger: {}, post: { dry_run: true, withheld: "write" } },
      trace: [
        { nodeId: "approve", output: { dry_run: true, withheld: "wait", skipped: "wait-for-event (dry run)" } },
        {
          nodeId: "post",
          output: {
            dry_run: true,
            withheld: "write",
            skipped: "state-changing request (not sent in a dry run)",
            would_call: [{ method: "POST", url: "https://slack.com/api/chat.postMessage" }],
          },
        },
      ],
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EditorRunButton />);

    await user.click(screen.getByRole("button", { name: "Dry run" }));

    expect(runWorkflowIr.mock.calls[0]![2]).toMatchObject({ workflowId: "wf-1", dryRun: true });
    expect(await screen.findByText("Dry run complete")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.getByText(/Writes \(POST, PUT, PATCH, DELETE\) are not sent/)).toBeInTheDocument();
    const withheld = within(screen.getByTestId("dry-run-withheld")).getAllByRole("listitem");
    expect(withheld.map((li) => li.textContent)).toEqual([
      "Ask first Not waited for — a dry run does not pause for an event",
      "Post the summary Not sent — would call POST https://slack.com/api/chat.postMessage",
    ]);
  });

  it("a real run does not ask for a dry one, and says real effects can fire", async () => {
    runWorkflowIr.mockResolvedValue({ run_id: "r-live", outputs: { trigger: {}, post: { status: 200 } } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EditorRunButton />);

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(runWorkflowIr.mock.calls[0]![2]?.dryRun).toBeUndefined();
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/Real effects can fire/)).toBeInTheDocument();
    expect(screen.queryByTestId("dry-run-withheld")).not.toBeInTheDocument();
  });

  // A dry run never parks, so its record is not polled — a poll could settle it as a real run's result.
  it("is never watched, however long it takes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EditorRunButton />);

    await user.click(screen.getByRole("button", { name: "Dry run" }));
    await act(() => vi.advanceTimersByTimeAsync(9500));

    expect(getRun).not.toHaveBeenCalled();
    expect(screen.getByText("Dry run in progress…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("a dry run that fails says so as a dry run", async () => {
    runWorkflowIr.mockRejectedValue(new api.ApiError("Workflow can't run: step \"post\" has no url", 400));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EditorRunButton />);

    await user.click(screen.getByRole("button", { name: "Dry run" }));

    expect(await screen.findByText("Dry run failed")).toBeInTheDocument();
    expect(screen.getByText(/has no url/)).toBeInTheDocument();
  });
});
