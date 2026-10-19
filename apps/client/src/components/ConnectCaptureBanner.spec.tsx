import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import type { StepAccount } from "@/api/client";
import ConnectCaptureBanner from "@/components/ConnectCaptureBanner";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  runAsAccounts: vi.fn(),
}));

const runAsAccounts = vi.mocked(api.runAsAccounts);

const step = (node_id: string, app: string, state: StepAccount["state"]): StepAccount => ({
  node_id,
  node_name: node_id,
  app,
  state,
  connection_id: state === "only" ? `conn-${app}` : null,
  accounts: state === "only" ? [`conn-${app}`] : [],
  managed_only: false,
  message: state === "only" ? null : "refused",
});

function canvas(nodes: Array<{ id: string; node_type: string }>): void {
  const doc = { version: "1", name: "w", nodes: nodes.map((n) => ({ ...n, name: n.id, parameters: {} })), edges: [] };
  useWorkflow.setState({ workflowJson: doc, workflowIr: structuredClone(doc), lastGeneratedJson: structuredClone(doc), dirty: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkflow.getState().reset();
});

describe("ConnectCaptureBanner", () => {
  it("offers to connect each app a step has no account for, and never writes one to the canvas", async () => {
    canvas([
      { id: "mail", node_type: "gmail.send_email" },
      { id: "post", node_type: "slack.send_channel_message" },
      { id: "think", node_type: "orchestr:agent" },
    ]);
    runAsAccounts.mockResolvedValue({
      steps: [step("mail", "gmail", "none"), step("post", "slack", "only"), step("think", "claude", "none")],
    });
    render(<ConnectCaptureBanner />);

    const banner = await screen.findByTestId("connect-capture-banner");
    expect(banner).toHaveTextContent("1 app needs connecting");
    expect(screen.getByTestId("connect-app-gmail")).toBeInTheDocument();
    // A model account is your own credentials, picked on the agent itself.
    expect(screen.queryByTestId("connect-app-claude")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connect-app-slack")).not.toBeInTheDocument();
    expect(useWorkflow.getState().dirty).toBe(false);
    const nodes = (useWorkflow.getState().workflowJson as { nodes: Array<{ parameters: Record<string, unknown> }> }).nodes;
    expect(nodes.every((n) => n.parameters.connectionId === undefined)).toBe(true);
  });

  it("stays out of the way when every step has an account to run as", async () => {
    canvas([{ id: "mail", node_type: "gmail.send_email" }]);
    runAsAccounts.mockResolvedValue({ steps: [step("mail", "gmail", "only")] });
    render(<ConnectCaptureBanner />);

    await waitFor(() => expect(runAsAccounts).toHaveBeenCalled());
    expect(screen.queryByTestId("connect-capture-banner")).not.toBeInTheDocument();
  });
});
