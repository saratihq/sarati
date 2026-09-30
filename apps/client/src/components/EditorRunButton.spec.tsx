import { act, render, screen } from "@testing-library/react";
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

  it("a cancelled run says it was cancelled", async () => {
    getRun.mockResolvedValue(watched({ status: "cancelled" }));
    await startAndWatchOnce();

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("The run was cancelled.")).toBeInTheDocument();
  });

  it("a run parked on an approval says it is waiting, and keeps being watched", async () => {
    getRun.mockResolvedValue(watched({ status: "waiting" }));
    await startAndWatchOnce();

    expect(screen.getByText("Waiting for a decision")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(getRun).toHaveBeenCalledTimes(2);
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
