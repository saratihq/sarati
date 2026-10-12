import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import WorkflowSettingsPage from "@/components/WorkflowSettingsPage";

const push = vi.fn();

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getWorkflow: vi.fn(() => Promise.resolve({ name: "Order intake" })),
  deleteWorkflow: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/WorkflowDetail", () => ({
  useWorkflowContext: () => ({ workflowId: "wf-1", workflowName: "Order intake", setWorkflowName: vi.fn() }),
}));

describe("WorkflowSettingsPage delete", () => {
  it("shows the delete in progress and blocks a second one until it settles", async () => {
    let settle = (): void => undefined;
    vi.mocked(api.deleteWorkflow).mockReturnValueOnce(
      new Promise((resolve) => (settle = () => resolve({ status: "deleted" }))),
    );
    render(<WorkflowSettingsPage />);

    await userEvent.click(screen.getByRole("button", { name: "Delete workflow" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "Order intake");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete workflow" }));

    const pending = await screen.findByRole("button", { name: /Deleting — removing its triggers from their apps/ });
    expect(pending).toBeDisabled();
    settle();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(api.deleteWorkflow).toHaveBeenCalledTimes(1);
  });
});
