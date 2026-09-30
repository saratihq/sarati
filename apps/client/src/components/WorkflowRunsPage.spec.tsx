import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
});
