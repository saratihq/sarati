import { render, screen, within } from "@testing-library/react";
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
}));

const listEnvironments = vi.mocked(envApi.listEnvironments);
const renameEnvironment = vi.mocked(envApi.renameEnvironment);

const qa: envApi.Environment = { id: "e1", name: "qa", is_prod: false, slots: [], pointer_count: 1, trigger_count: 1 };

const moved: envApi.UrlChange = {
  workflow_id: "wf1",
  workflow_name: "Order intake",
  trigger: "webhook",
  from: "/api/hooks/wf1/qa",
  to: "/api/hooks/wf1/qa-two",
};

async function renameTo(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Rename qa" }));
  const input = screen.getByRole("textbox", { name: "Environment name" });
  await userEvent.clear(input);
  await userEvent.type(input, `${name}{Enter}`);
}

beforeEach(() => {
  listEnvironments.mockReset().mockResolvedValue({ environments: [qa] });
  renameEnvironment.mockReset();
  vi.mocked(api.listConnections).mockResolvedValue({ connections: [] } as never);
});

describe("EnvironmentsSettings rename", () => {
  it("lists the webhook and chat URLs a rename moves, and renames only once that is confirmed", async () => {
    renameEnvironment
      .mockRejectedValueOnce(new envApi.RenameMovesUrlsError("moves 1 URL", [moved]))
      .mockResolvedValueOnce(undefined);
    render(<EnvironmentsSettings />);

    await renameTo("qa-two");

    const dialog = await screen.findByRole("dialog", { name: "Rename qa to qa-two?" });
    expect(within(dialog).getByText("Order intake")).toBeInTheDocument();
    expect(within(dialog).getByText("· Incoming webhook")).toBeInTheDocument();
    expect(within(dialog).getByText(api.absoluteApiUrl("/api/hooks/wf1/qa-two"))).toBeInTheDocument();
    expect(screen.getByText("qa", { selector: "span" })).toBeInTheDocument();
    expect(renameEnvironment).toHaveBeenLastCalledWith("e1", "qa-two", false);

    await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(renameEnvironment).toHaveBeenLastCalledWith("e1", "qa-two", true);
    expect(await screen.findByText("qa-two", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leaves the environment as it was when the rename is cancelled", async () => {
    renameEnvironment.mockRejectedValueOnce(new envApi.RenameMovesUrlsError("moves 1 URL", [moved]));
    render(<EnvironmentsSettings />);

    await renameTo("qa-two");
    const dialog = await screen.findByRole("dialog", { name: "Rename qa to qa-two?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(renameEnvironment).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("qa", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("qa-two", { selector: "span" })).not.toBeInTheDocument();
  });
});
