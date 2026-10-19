import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import * as envApi from "@/api/environments";
import EnvironmentsSettings from "@/components/EnvironmentsSettings";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listConnections: vi.fn(),
}));

vi.mock("@/api/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof envApi>()),
  listEnvironments: vi.fn(),
  renameEnvironment: vi.fn(),
  deleteEnvironment: vi.fn(),
}));

const listEnvironments = vi.mocked(envApi.listEnvironments);
const renameEnvironment = vi.mocked(envApi.renameEnvironment);
const deleteEnvironment = vi.mocked(envApi.deleteEnvironment);

const qa: envApi.Environment = { id: "e1", name: "qa", is_prod: false, slots: [], pointer_count: 1, trigger_count: 1 };

const moved: envApi.UrlChange = {
  workflow_id: "wf1",
  workflow_name: "Order intake",
  trigger: "webhook",
  from: "/api/hooks/wf1/qa",
  to: "/api/hooks/wf1/qa-two",
};

const late: envApi.UrlChange = { ...moved, workflow_id: "wf2", workflow_name: "Late intake", from: "/api/hooks/wf2/qa", to: "/api/hooks/wf2/qa-two" };

async function renameTo(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Rename qa" }));
  const input = screen.getByRole("textbox", { name: "Environment name" });
  await userEvent.clear(input);
  await userEvent.type(input, `${name}{Enter}`);
}

beforeEach(() => {
  listEnvironments.mockReset().mockResolvedValue({ environments: [qa] });
  renameEnvironment.mockReset();
  deleteEnvironment.mockReset();
  vi.mocked(api.listConnections).mockResolvedValue({ connections: [] } as never);
});

describe("EnvironmentsSettings rename", () => {
  it("lists the old and new URL of each webhook and chat a rename moves, and renames once that list is confirmed", async () => {
    renameEnvironment
      .mockRejectedValueOnce(new envApi.RenameMovesUrlsError("moves 1 URL", [moved]))
      .mockResolvedValueOnce(undefined);
    render(<EnvironmentsSettings />);

    await renameTo("qa-two");

    const dialog = await screen.findByRole("dialog", { name: "Rename qa to qa-two?" });
    expect(within(dialog).getByText("Order intake")).toBeInTheDocument();
    expect(within(dialog).getByText("· Incoming webhook")).toBeInTheDocument();
    expect(within(dialog).getByText("http://localhost:8001/api/hooks/wf1/qa")).toBeInTheDocument();
    expect(within(dialog).getByText("http://localhost:8001/api/hooks/wf1/qa-two")).toBeInTheDocument();
    expect(screen.getByText("qa", { selector: "span" })).toBeInTheDocument();
    expect(renameEnvironment).toHaveBeenLastCalledWith("e1", "qa-two", undefined);

    await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(renameEnvironment).toHaveBeenLastCalledWith("e1", "qa-two", [moved]);
    expect(await screen.findByText("qa-two", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename qa-two" })).toHaveFocus();
  });

  it("leaves the environment as it was when the rename is cancelled, with focus back on its rename button", async () => {
    renameEnvironment.mockRejectedValueOnce(new envApi.RenameMovesUrlsError("moves 1 URL", [moved]));
    render(<EnvironmentsSettings />);

    await renameTo("qa-two");
    const dialog = await screen.findByRole("dialog", { name: "Rename qa to qa-two?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(renameEnvironment).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("qa", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("qa-two", { selector: "span" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename qa" })).toHaveFocus();
  });

  it("asks again, with the full list, when more URLs changed after the user confirmed", async () => {
    renameEnvironment
      .mockRejectedValueOnce(new envApi.RenameMovesUrlsError("moves 1 URL", [moved]))
      .mockRejectedValueOnce(new envApi.RenameMovesUrlsError("now moves 2", [late, moved]));
    render(<EnvironmentsSettings />);

    await renameTo("qa-two");
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Rename qa to qa-two?" })).getByRole("button", { name: "Rename" }),
    );

    const again = await screen.findByRole("dialog", { name: "Rename qa to qa-two?" });
    expect(within(again).getByText(/More trigger URLs change than the ones you confirmed/)).toBeInTheDocument();
    expect(within(again).getByText("Late intake")).toBeInTheDocument();
    expect(within(again).getByText("Order intake")).toBeInTheDocument();
    expect(screen.getByText("qa", { selector: "span" })).toBeInTheDocument();
  });
});

describe("EnvironmentsSettings delete", () => {
  it("shows the delete in progress and blocks a second one until it settles", async () => {
    let settle = (): void => undefined;
    deleteEnvironment.mockReturnValueOnce(
      new Promise((resolve) => (settle = () => resolve({ removed_pointers: 1, unbound_triggers: 1 }))),
    );
    render(<EnvironmentsSettings />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete qa" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete environment" }));

    expect(await screen.findByText(/Deleting — removing its triggers from their apps/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete qa" })).toBeDisabled();
    listEnvironments.mockResolvedValue({ environments: [] });
    settle();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete qa" })).not.toBeInTheDocument());
    expect(deleteEnvironment).toHaveBeenCalledTimes(1);
  });
});

describe("EnvironmentsSettings assign picker", () => {
  it("offers only the accounts the service says serve the app, a family account included", async () => {
    const account = (id: string, provider: string) =>
      ({ id, provider, display_name: null, auth_type: "token", status: "active", account: null }) as api.Connection;
    const zoho = account("c-zoho", "zoho");
    listEnvironments.mockResolvedValue({
      environments: [
        {
          ...qa,
          slots: [
            {
              app: "zoho-crm",
              connection_id: "c-old",
              account_label: "old@e2e.local",
              owner_user_id: "u1",
              owner_label: "old@e2e.local",
              status: "expired",
            },
          ],
        },
      ],
    });
    vi.mocked(api.listConnections).mockImplementation((app?: string) =>
      Promise.resolve({ connections: app === "zoho-crm" ? [zoho] : [zoho, account("c-slack", "slack")] }),
    );
    render(<EnvironmentsSettings />);

    await userEvent.click(await screen.findByRole("button", { name: "Replace Zoho Crm in qa" }));

    const picker = await screen.findByRole("group", { name: "Assign Zoho Crm in qa" });
    expect(await within(picker).findByText("Zoho")).toBeInTheDocument();
    expect(within(picker).queryByText("Slack")).not.toBeInTheDocument();
    expect(api.listConnections).toHaveBeenCalledWith("zoho-crm");
  });
});
