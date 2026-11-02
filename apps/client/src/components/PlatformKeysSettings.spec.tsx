import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import PlatformKeysSettings from "@/components/PlatformKeysSettings";
import { useOrgs } from "@/store/useOrgs";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listPlatformKeys: vi.fn(),
  setPlatformKey: vi.fn(),
  clearPlatformKey: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/useComposerAvailable", () => ({ refreshComposerAvailability: vi.fn() }));

const listPlatformKeys = vi.mocked(api.listPlatformKeys);

const own = (present = false): api.PlatformKeyState => ({
  present,
  updated_at: present ? "2026-10-01T00:00:00.000Z" : null,
  managed_by_instance: false,
});
const instance: api.PlatformKeyState = { present: true, updated_at: null, managed_by_instance: true };

const perPerson = (): api.PlatformKeysResponse => ({
  keys: { composio_api_key: own(true), composio_webhook_secret: own(), anthropic_api_key: own() },
  scope: "user",
  can_manage: true,
  composio_usage: null,
});

const byInstance = (usage: Partial<api.ComposioUsage> = {}): api.PlatformKeysResponse => ({
  keys: { composio_api_key: instance, composio_webhook_secret: instance, anthropic_api_key: own() },
  scope: "user",
  can_manage: true,
  composio_usage: {
    actions_used: 37,
    actions_limit: 500,
    trigger_events: 0,
    resets_at: "2026-12-01T00:00:00.000Z",
    ...usage,
  },
});

const managedRow = () => screen.getByText("Managed connections (Composio)").closest("div.rounded-lg") as HTMLElement;

beforeEach(() => {
  useOrgs.setState({ orgs: [], activeOrgId: null });
});

describe("PlatformKeysSettings", () => {
  it("on an instance that provides its Composio account, shows one row with nothing to enter, and how much is used", async () => {
    listPlatformKeys.mockResolvedValue(byInstance());
    render(<PlatformKeysSettings />);

    expect(await screen.findByText("Managed connections (Composio)")).toBeInTheDocument();
    const row = managedRow();
    expect(within(row).getByText("Provided by this instance")).toBeInTheDocument();
    expect(within(row).getByText("You've used 37 of 500 app actions this month · resets December 1 (UTC)")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Composio API key")).not.toBeInTheDocument();
    expect(screen.queryByText("Composio webhook secret")).not.toBeInTheDocument();
    expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add key" })).toBeInTheDocument();
  });

  it("warns once the month's actions are used up, naming when they come back", async () => {
    listPlatformKeys.mockResolvedValue(byInstance({ actions_used: 500, trigger_events: 3 }));
    render(<PlatformKeysSettings />);

    const line = await screen.findByText(
      "All 500 app actions used — steps on one-click accounts stop until December 1 (UTC).",
    );
    expect(line).toHaveStyle({ color: "var(--orchestr-warning)" });
    expect(screen.getByText("3 app trigger events received this month")).toBeInTheDocument();
  });

  it("says app actions are off when the instance allows none", async () => {
    listPlatformKeys.mockResolvedValue(byInstance({ actions_used: 0, actions_limit: 0 }));
    render(<PlatformKeysSettings />);

    expect(
      await screen.findByText("App actions are off on this instance — the count starts again December 1 (UTC)."),
    ).toBeInTheDocument();
  });

  it("without one, shows each Composio key as before, editable, with no usage line", async () => {
    listPlatformKeys.mockResolvedValue(perPerson());
    render(<PlatformKeysSettings />);

    expect(await screen.findByText("Composio API key")).toBeInTheDocument();
    expect(screen.getByText("Composio webhook secret")).toBeInTheDocument();
    expect(screen.queryByText("Managed connections (Composio)")).not.toBeInTheDocument();
    expect(screen.queryByText(/app actions/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add key" })).toHaveLength(2);
  });

  it("offers a retry when the keys can't be read, and shows them once they can", async () => {
    listPlatformKeys.mockRejectedValueOnce(new Error("The server is unreachable")).mockResolvedValue(byInstance());
    render(<PlatformKeysSettings />);

    expect(await screen.findByText("The server is unreachable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Managed connections (Composio)")).toBeInTheDocument();
  });
});
