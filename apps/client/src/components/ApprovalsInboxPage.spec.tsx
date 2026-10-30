import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import ApprovalsInboxPage from "@/components/ApprovalsInboxPage";
import { clearLocalSession, LOCAL_SESSION_COOKIE } from "@/lib/localSession";
import { useToasts } from "@/lib/toast";
import { useApprovals } from "@/store/useApprovals";

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
  waits: 1,
  topic: "approval",
  waiting_since: "2026-10-09T09:00:00.000Z",
  timeout_at: null,
  triggered_by: { id: "u-1", email: "ana@example.com", name: "Ana" },
  ...over,
});

describe("ApprovalsInboxPage", () => {
  beforeEach(() => {
    useApprovals.setState({ waiting: null, isLoading: false, error: null });
  });

  afterEach(() => {
    api.setActiveOrgId(null);
    clearLocalSession();
  });

  it("lists each wait of a run parked on two at once, and a decision names the one step it answers", async () => {
    const legal = wait({ step_key: "legal", node_id: "legal", topic: "legal" });
    const finance = wait({ step_key: "finance", node_id: "finance", topic: "finance" });
    listWaitingRuns.mockResolvedValue({ runs: [legal, finance] });
    sendRunEvent.mockResolvedValue();
    const user = userEvent.setup();
    render(<ApprovalsInboxPage />);

    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => within(row).getAllByText(/^(legal|finance)$/)[0]!.textContent)).toEqual([
      "legal",
      "finance",
    ]);

    await user.click(within(rows[1]!).getByRole("button", { name: "Approve" }));

    expect(sendRunEvent).toHaveBeenCalledTimes(1);
    expect(sendRunEvent).toHaveBeenCalledWith(
      "u-1:r-1",
      { topic: "finance", step_key: "finance", payload: expect.objectContaining({ decision: "approved" }) },
      undefined,
    );
    const left = screen.getAllByRole("listitem");
    expect(left).toHaveLength(1);
    expect(within(left[0]!).getAllByText("legal")).not.toHaveLength(0);
  });

  it("names its step on each row, so two waits on one topic can be told apart", async () => {
    listWaitingRuns.mockResolvedValue({
      runs: [
        wait({ step_key: "fork|0/manager", node_id: "manager" }),
        wait({ step_key: "fork|1/finance_lead", node_id: "finance_lead" }),
      ],
    });
    render(<ApprovalsInboxPage />);

    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]!).getByText("fork|0/manager")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("fork|1/finance_lead")).toBeInTheDocument();
    expect(rows[0]!.textContent).not.toBe(rows[1]!.textContent);
  });

  it("answers waits sharing one receive by topic alone, naming no step", async () => {
    listWaitingRuns.mockResolvedValue({ runs: [wait({ step_key: null, node_id: null, waits: 2 })] });
    sendRunEvent.mockResolvedValue();
    const user = userEvent.setup();
    render(<ApprovalsInboxPage />);

    const [row] = await screen.findAllByRole("listitem");
    expect(within(row!).getByText("2 waits share this decision — one will receive it")).toBeInTheDocument();
    await user.click(within(row!).getByRole("button", { name: "Approve" }));

    expect(sendRunEvent).toHaveBeenCalledWith(
      "u-1:r-1",
      { topic: "approval", payload: expect.objectContaining({ decision: "approved" }) },
      undefined,
    );
  });

  it("sends a rejection as and where it was decided when its Undo window closes after the session changed", async () => {
    document.cookie = `${LOCAL_SESSION_COOKIE}=ana; Path=/`;
    api.setActiveOrgId("org-a");
    listWaitingRuns.mockResolvedValue({ runs: [wait({})] });
    sendRunEvent.mockResolvedValue();
    const user = userEvent.setup();
    render(<ApprovalsInboxPage />);

    const [row] = await screen.findAllByRole("listitem");
    await user.click(within(row!).getByRole("button", { name: "Reject" }));
    // A workspace switch saves the new workspace before its reload, and the window can close in between.
    api.setActiveOrgId("org-b");
    useToasts.getState().dismiss(useToasts.getState().toasts.find((t) => t.title === "Rejected")!.id);

    await waitFor(() => expect(sendRunEvent).toHaveBeenCalledTimes(1));
    expect(sendRunEvent).toHaveBeenCalledWith(
      "u-1:r-1",
      { topic: "approval", step_key: "approve", payload: expect.objectContaining({ decision: "rejected" }) },
      { as: { token: "ana", orgId: "org-a" }, keepalive: true },
    );
  });

  it("sends a rejection still inside its Undo window when the page is left, as and where it was decided", async () => {
    document.cookie = `${LOCAL_SESSION_COOKIE}=ana; Path=/`;
    api.setActiveOrgId("org-a");
    listWaitingRuns.mockResolvedValue({ runs: [wait({})] });
    sendRunEvent.mockResolvedValue();
    const user = userEvent.setup();
    render(<ApprovalsInboxPage />);

    const [row] = await screen.findAllByRole("listitem");
    await user.click(within(row!).getByRole("button", { name: "Reject" }));
    expect(sendRunEvent).not.toHaveBeenCalled();

    // Signing out ends the session and the workspace before its navigation unloads the page.
    clearLocalSession();
    api.setActiveOrgId(null);
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(sendRunEvent).toHaveBeenCalledTimes(1));
    expect(sendRunEvent).toHaveBeenCalledWith(
      "u-1:r-1",
      { topic: "approval", step_key: "approve", payload: expect.objectContaining({ decision: "rejected" }) },
      { as: { token: "ana", orgId: "org-a" }, keepalive: true },
    );
  });
});
