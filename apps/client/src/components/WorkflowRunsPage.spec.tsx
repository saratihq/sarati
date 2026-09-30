import { render, screen } from "@testing-library/react";
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
});
