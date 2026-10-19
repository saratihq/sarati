import { render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import * as api from "@/api/client";
import ComposerBar from "@/components/ComposerBar";
import WorkflowNode from "@/components/WorkflowNode";
import { refreshComposerAvailability } from "@/lib/useComposerAvailable";
import { useComposer } from "@/store/useComposer";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerStatus: vi.fn(),
  composerAttach: vi.fn(),
  refreshSessionToken: vi.fn(),
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  runAsAccounts: vi.fn(),
}));

const runAsAccounts = vi.mocked(api.runAsAccounts);

function renderNode(id: string, nodeType: string, category: string) {
  const props = {
    id,
    data: { label: id, color: "", category, nodeType, parameters: {}, staticEntrance: true },
    selected: false,
  } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <ComposerBar workflowId="wf-1" />
      <WorkflowNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("the composer's Connect chip on a canvas node", () => {
  beforeEach(() => {
    refreshComposerAvailability();
    useComposer.getState().reset();
    vi.mocked(agent.composerStatus).mockResolvedValue({ available: true });
    vi.mocked(agent.composerAttach).mockImplementation(async function* () {});
  });

  it("shows on an app trigger as the composer placed it — what a trigger listens as is its environment's", async () => {
    useWorkflow.setState({
      workflowJson: {
        nodes: [
          {
            id: "trigger",
            name: "New email",
            node_type: "gmail.new_email_trigger",
            parameters: {},
            metadata: { trigger: true },
          },
        ],
        edges: [],
      },
    });
    useComposer.setState({ connectionNeeds: { trigger: { provider: "gmail", providerLabel: "Gmail" } } });
    runAsAccounts.mockResolvedValue({ steps: [] });
    renderNode("trigger", "gmail.new_email_trigger", "trigger");

    expect(await screen.findByTestId("node-connect")).toHaveTextContent("Gmail");
  });

  it("stays off a step that connecting wouldn't fix, though the composer asked while it had none", async () => {
    useWorkflow.setState({
      workflowJson: {
        nodes: [
          { id: "send_report", name: "Email me", node_type: "gmail.send_email", parameters: {} },
          { id: "post", name: "Post", node_type: "slack.send_channel_message", parameters: {} },
        ],
        edges: [],
      },
    });
    useComposer.setState({
      connectionNeeds: {
        send_report: { provider: "gmail", providerLabel: "Gmail" },
        post: { provider: "slack", providerLabel: "Slack" },
      },
    });
    runAsAccounts.mockResolvedValue({
      steps: [
        {
          node_id: "send_report",
          node_name: "Email me",
          app: "gmail",
          state: "several",
          connection_id: null,
          accounts: ["conn-1", "conn-2"],
          managed_only: false,
          message: 'Step "Email me" has no gmail account chosen and you have 2 active gmail accounts — pick one on the step',
        },
        {
          node_id: "post",
          node_name: "Post",
          app: "slack",
          state: "none",
          connection_id: null,
          accounts: [],
          managed_only: false,
          message: 'Step "Post" has no slack account to run as — connect one',
        },
      ],
    });
    renderNode("send_report", "gmail.send_email", "action");

    expect(await screen.findByTestId("composer-connects")).toHaveTextContent("Slack");
    expect(screen.queryByTestId("node-connect")).not.toBeInTheDocument();
  });

  it("shows on a step as the composer placed it while what the step runs as can't be checked", async () => {
    useWorkflow.setState({
      workflowJson: {
        nodes: [{ id: "send_report", name: "Email me", node_type: "gmail.send_email", parameters: {} }],
        edges: [],
      },
    });
    useComposer.setState({ connectionNeeds: { send_report: { provider: "gmail", providerLabel: "Gmail" } } });
    runAsAccounts.mockRejectedValue(new Error("The service is unreachable."));
    renderNode("send_report", "gmail.send_email", "action");

    expect(await screen.findByTestId("node-connect")).toHaveTextContent("Gmail");
  });

  it("stays off a step that already runs as an account", async () => {
    useWorkflow.setState({
      workflowJson: {
        nodes: [{ id: "send_report", name: "Email me", node_type: "gmail.send_email", parameters: {} }],
        edges: [],
      },
    });
    useComposer.setState({ connectionNeeds: { send_report: { provider: "gmail", providerLabel: "Gmail" } } });
    runAsAccounts.mockResolvedValue({
      steps: [
        {
          node_id: "send_report",
          node_name: "Email me",
          app: "gmail",
          state: "only",
          connection_id: "conn-1",
          accounts: ["conn-1"],
          managed_only: false,
          message: null,
        },
      ],
    });
    renderNode("send_report", "gmail.send_email", "action");

    await vi.waitFor(() => expect(runAsAccounts).toHaveBeenCalled());
    await runAsAccounts.mock.results[0]!.value;
    expect(screen.queryByTestId("node-connect")).not.toBeInTheDocument();
  });
});
