import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import type { Connection, StepAccount } from "@/api/client";
import ConnectionHealthBanner from "@/components/ConnectionHealthBanner";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listConnections: vi.fn(),
  runAsAccounts: vi.fn(),
}));

const listConnections = vi.mocked(api.listConnections);
const runAsAccounts = vi.mocked(api.runAsAccounts);

const connection = (id: string, provider: string, status: Connection["status"], auth_type = "token"): Connection => ({
  id,
  provider,
  display_name: null,
  auth_type,
  status,
  status_reason: status === "active" ? null : "Access has expired",
});

const step = (node_id: string, app: string, state: StepAccount["state"], managed_only = false): StepAccount => ({
  node_id,
  node_name: node_id,
  app,
  state,
  connection_id: state === "only" ? `conn-${app}` : null,
  accounts: state === "only" ? [`conn-${app}`] : [],
  managed_only,
  message: state === "only" ? null : "refused",
});

// The caller's connections: all of them, or those `?app=` says serve an app.
function connections(all: Connection[], serving: Record<string, Connection[]> = {}): void {
  listConnections.mockImplementation((app?: string) =>
    Promise.resolve({ connections: app === undefined ? all : (serving[app] ?? []) }),
  );
}

const mail = { id: "mail", name: "Email me", node_type: "gmail.send_email", parameters: {} };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConnectionHealthBanner", () => {
  it("flags the expired account a step with none chosen runs as, by the run-as rule's own answer", async () => {
    const expired = connection("g1", "gmail", "expired");
    connections([expired], { gmail: [expired] });
    runAsAccounts.mockResolvedValue({ steps: [step("mail", "gmail", "none")] });
    const nodes = [mail];
    render(<ConnectionHealthBanner nodes={nodes} />);

    const banner = await screen.findByTestId("connection-health-banner");
    expect(banner).toHaveTextContent("The Gmail connection needs reconnecting — fix it in Integrations.");
    expect(runAsAccounts).toHaveBeenCalledWith({ nodes });
    expect(listConnections).toHaveBeenCalledWith("gmail");
  });

  it("stays hidden while that step runs as an active account, and when it has no account at all", async () => {
    connections([connection("g1", "gmail", "active")], { gmail: [connection("g1", "gmail", "active")] });
    runAsAccounts.mockResolvedValue({ steps: [step("mail", "gmail", "only")] });
    const { unmount } = render(<ConnectionHealthBanner nodes={[mail]} />);
    await waitFor(() => expect(runAsAccounts).toHaveBeenCalled());
    expect(screen.queryByTestId("connection-health-banner")).not.toBeInTheDocument();
    unmount();

    connections([]);
    runAsAccounts.mockResolvedValue({ steps: [step("mail", "gmail", "none")] });
    render(<ConnectionHealthBanner nodes={[mail]} />);
    await waitFor(() => expect(listConnections).toHaveBeenCalledWith("gmail"));
    expect(screen.queryByTestId("connection-health-banner")).not.toBeInTheDocument();
  });

  it("names only a one-click account for a step only one-click accounts run", async () => {
    const ownKey = connection("s1", "slack", "expired");
    const oneClick = { ...connection("s2", "slack", "failed", "managed"), display_name: "Team Slack" };
    connections([ownKey, oneClick], { slack: [ownKey, oneClick] });
    runAsAccounts.mockResolvedValue({ steps: [step("remind", "slack", "none", true)] });
    render(<ConnectionHealthBanner nodes={[{ id: "remind", node_type: "slack.create_a_reminder" }]} />);

    expect(await screen.findByTestId("connection-health-banner")).toHaveTextContent(
      "The Team Slack connection needs reconnecting",
    );
  });

  it("still flags an account a step chose that isn't active, and keeps it when the run-as ask fails", async () => {
    connections([connection("c1", "slack", "expired")]);
    runAsAccounts.mockRejectedValue(new Error("offline"));
    render(<ConnectionHealthBanner nodes={[{ id: "post", node_type: "slack.post", parameters: { connectionId: "c1" } }]} />);

    expect(await screen.findByTestId("connection-health-banner")).toHaveTextContent(
      "The Slack connection needs reconnecting",
    );
  });
});
