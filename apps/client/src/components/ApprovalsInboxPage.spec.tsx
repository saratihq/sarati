import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import ApprovalsInboxPage from "@/components/ApprovalsInboxPage";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listWaitingRuns: vi.fn(),
  sendRunEvent: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const listWaitingRuns = vi.mocked(api.listWaitingRuns);
const sendRunEvent = vi.mocked(api.sendRunEvent);

const wait = (over: Partial<api.WaitingRun>): api.WaitingRun => ({
  id: "u-1:r-1",
  run_id: "r-1",
  workflow_id: "wf-1",
  workflow_name: "Purchase order",
  step_key: "approve",
  node_id: "approve",
  topic: "approval",
  waiting_since: "2026-10-09T09:00:00.000Z",
  timeout_at: null,
  triggered_by: { id: "u-1", email: "ana@example.com", name: "Ana" },
  ...over,
});

describe("ApprovalsInboxPage", () => {
  it("lists each wait of a run parked on two at once, and a decision names the one step it answers", async () => {
    const legal = wait({ step_key: "legal", node_id: "legal", topic: "legal" });
    const finance = wait({ step_key: "finance", node_id: "finance", topic: "finance" });
    listWaitingRuns.mockResolvedValue({ runs: [legal, finance] });
    sendRunEvent.mockResolvedValue();
    const user = userEvent.setup();
    render(<ApprovalsInboxPage />);

    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/^(legal|finance)$/).textContent)).toEqual(["legal", "finance"]);

    await user.click(within(rows[1]!).getByRole("button", { name: "Approve" }));

    expect(sendRunEvent).toHaveBeenCalledTimes(1);
    expect(sendRunEvent).toHaveBeenCalledWith("u-1:r-1", {
      topic: "finance",
      step_key: "finance",
      payload: expect.objectContaining({ decision: "approved" }),
    });
    const left = screen.getAllByRole("listitem");
    expect(left).toHaveLength(1);
    expect(within(left[0]!).getByText("legal")).toBeInTheDocument();
  });
});
