import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import * as api from "@/api/client";
import type { StepAccount } from "@/api/client";
import ComposerBar from "@/components/ComposerBar";
import ConnectCaptureBanner from "@/components/ConnectCaptureBanner";
import { connectAppWithFeedback } from "@/lib/managedConnect";
import { refreshComposerAvailability } from "@/lib/useComposerAvailable";
import { useComposer } from "@/store/useComposer";
import { useOrgs } from "@/store/useOrgs";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerStatus: vi.fn(),
  composerAttach: vi.fn(),
  composerStream: vi.fn(),
  refreshSessionToken: vi.fn(),
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  runAsAccounts: vi.fn(),
}));
vi.mock("@/lib/managedConnect", () => ({ connectAppWithFeedback: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const composerStatus = vi.mocked(agent.composerStatus);
const composerAttach = vi.mocked(agent.composerAttach);
const composerStream = vi.mocked(agent.composerStream);
const runAsAccounts = vi.mocked(api.runAsAccounts);
const connect = vi.mocked(connectAppWithFeedback);

beforeEach(() => {
  refreshComposerAvailability();
  useComposer.getState().reset();
  composerAttach.mockImplementation(async function* () {});
  composerStream.mockImplementation(async function* () {});
});

describe("ComposerBar reattach", () => {
  it("never asks an instance without the composer for a thread", async () => {
    composerStatus.mockResolvedValue({ available: false, reason: "anthropic_api_key_missing" });
    render(<ComposerBar workflowId="wf-1" />);

    await waitFor(() => expect(composerStatus).toHaveBeenCalledTimes(1));
    await composerStatus.mock.results[0]!.value;
    expect(composerAttach).not.toHaveBeenCalled();
    expect(useComposer.getState().failure).toBeNull();
  });

  it("reattaches to the workflow's thread once the probe says the composer is here", async () => {
    composerStatus.mockResolvedValue({ available: true });
    render(<ComposerBar workflowId="wf-1" />);

    await waitFor(() => expect(composerAttach).toHaveBeenCalledTimes(1));
    expect(composerAttach.mock.calls[0]![0]).toMatchObject({ workflowId: "wf-1", scratch: false });
  });
});

describe("ComposerBar save offer", () => {
  const offerFor = async (role: "member" | "owner"): Promise<string> => {
    composerStatus.mockResolvedValue({ available: true });
    useOrgs.setState({ orgs: [{ id: "o1", name: "Team", is_personal: false, role }], activeOrgId: "o1" });
    useComposer.setState({ offerPending: true });
    render(<ComposerBar />);
    return (await screen.findByTestId("offer-save-live")).textContent?.trim() ?? "";
  };

  it("offers to save and turn on a new workflow to someone who may publish", async () => {
    expect(await offerFor("owner")).toBe("Save and turn on");
  });

  it("offers only to save it to a member, whose new workflow an owner or admin turns on", async () => {
    expect(await offerFor("member")).toBe("Save");
  });
});

describe("ComposerBar on a canvas that can't be saved", () => {
  it("holds the save chip and says why, as the editor's own Save does", async () => {
    composerStatus.mockResolvedValue({ available: true });
    useComposer.setState({ offerPending: true });
    render(<ComposerBar workflowId="wf-1" saveBlocked="main is protected — changes come in through a review" />);

    expect(await screen.findByTestId("offer-save-live")).toBeDisabled();
    expect(screen.getByText("main is protected — changes come in through a review")).toBeInTheDocument();
    expect(screen.getByTestId("offer-tweak")).toBeEnabled();
  });
});

describe("ComposerBar Connect chips", () => {
  const canvasWith = (ids: string[]) =>
    useWorkflow.setState({
      workflowJson: { nodes: ids.map((id) => ({ id, name: id, node_type: "gmail.send_email", parameters: {} })), edges: [] },
    });
  const runsAs = (state: StepAccount["state"]) =>
    runAsAccounts.mockResolvedValue({
      steps: [
        {
          node_id: "send_report",
          node_name: "send_report",
          app: "gmail",
          state,
          connection_id: state === "only" ? "conn-new" : null,
          accounts: state === "only" ? ["conn-new"] : [],
          managed_only: false,
          message: state === "only" ? null : 'Step "send_report" has no gmail account to run as — connect one',
        },
      ],
    });

  beforeEach(() => {
    composerStatus.mockResolvedValue({ available: true });
    useComposer.setState({ connectionNeeds: { send_report: { provider: "gmail", providerLabel: "Gmail" } } });
  });

  it("asks for an app only while a step that needs it is on the canvas", async () => {
    canvasWith(["trigger", "send_report"]);
    runsAs("none");
    render(<ComposerBar workflowId="wf-1" />);
    expect(await screen.findByTestId("composer-connects")).toHaveTextContent("Gmail");

    act(() => canvasWith(["trigger"]));
    expect(screen.queryByTestId("composer-connects")).not.toBeInTheDocument();
  });

  it("asks only while the step has no account to run as — connecting one from the banner retires it", async () => {
    canvasWith(["send_report"]);
    runsAs("none");
    connect.mockResolvedValue("conn-new");
    render(
      <>
        <ConnectCaptureBanner />
        <ComposerBar workflowId="wf-1" />
      </>,
    );
    expect(await screen.findByTestId("composer-connects")).toHaveTextContent("Gmail");

    runsAs("only");
    await userEvent.click(screen.getByTestId("connect-app-gmail"));

    await waitFor(() => expect(screen.queryByTestId("connect-capture-banner")).not.toBeInTheDocument());
    expect(screen.queryByTestId("composer-connects")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-connect")).not.toBeInTheDocument();
  });

  it("still asks as the composer placed it when what the step runs as can't be checked", async () => {
    canvasWith(["send_report"]);
    runAsAccounts.mockRejectedValue(new Error("The service is unreachable."));
    render(<ComposerBar workflowId="wf-1" />);

    expect(await screen.findByTestId("composer-connects")).toHaveTextContent("Gmail");
  });

  it.each(["only", "chosen"] as const)(
    "never asks for a step that already runs as an account (%s)",
    async (state) => {
      canvasWith(["send_report"]);
      runAsAccounts.mockResolvedValue({
        steps: [
          {
            node_id: "send_report",
            node_name: "send_report",
            app: "gmail",
            state,
            connection_id: "conn-1",
            accounts: ["conn-1"],
            managed_only: false,
            message: null,
          },
        ],
      });
      render(<ComposerBar workflowId="wf-1" />);

      await waitFor(() => expect(runAsAccounts).toHaveBeenCalled());
      await act(() => runAsAccounts.mock.results[0]!.value as Promise<unknown>);
      expect(screen.queryByTestId("composer-connects")).not.toBeInTheDocument();
    },
  );

  it.each(["several", "stale", "inactive", "wrong_app", "needs_managed"] as const)(
    "never asks where connecting isn't the fix, even for a need placed before (%s)",
    async (state) => {
      useWorkflow.setState({
        workflowJson: {
          nodes: [
            { id: "send_report", name: "send_report", node_type: "gmail.send_email", parameters: {} },
            { id: "post", name: "post", node_type: "slack.send_channel_message", parameters: {} },
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
      const step = (node_id: string, app: string, state: StepAccount["state"]): StepAccount => ({
        node_id,
        node_name: node_id,
        app,
        state,
        connection_id: null,
        accounts: [],
        managed_only: false,
        message: `Step "${node_id}" can't run`,
      });
      runAsAccounts.mockResolvedValue({ steps: [step("send_report", "gmail", state), step("post", "slack", "none")] });
      render(<ComposerBar workflowId="wf-1" />);

      expect(await screen.findByTestId("composer-connects")).toHaveTextContent("Slack");
      expect(screen.getByTestId("composer-connects")).not.toHaveTextContent("Gmail");
    },
  );

  describe("beside an app trigger, whose account is its environment's", () => {
    const TRIGGER = {
      id: "trigger",
      name: "New email",
      node_type: "gmail.new_email_trigger",
      parameters: {},
      metadata: { trigger: true },
    };
    const EMAIL_ME = { id: "send_report", name: "Email me", node_type: "gmail.send_email", parameters: {} };
    const emailMe = (state: "none" | "only"): StepAccount => ({
      node_id: "send_report",
      node_name: "Email me",
      app: "gmail",
      state,
      connection_id: state === "only" ? "conn-new" : null,
      accounts: state === "only" ? ["conn-new"] : [],
      managed_only: false,
      message: state === "only" ? null : 'Step "Email me" has no gmail account to run as — connect one',
    });

    beforeEach(() => {
      useWorkflow.setState({ workflowJson: { nodes: [TRIGGER, EMAIL_ME], edges: [] } });
    });

    it("a trigger's ask shows as the composer placed it, while a step that runs as an account asks nothing", async () => {
      useComposer.setState({
        connectionNeeds: {
          trigger: { provider: "gmail", providerLabel: "Gmail" },
          send_report: { provider: "gmail", providerLabel: "Gmail" },
        },
      });
      runAsAccounts.mockResolvedValue({ steps: [emailMe("only")] });
      render(<ComposerBar workflowId="wf-1" />);

      expect(await screen.findByTestId("composer-connects")).toHaveTextContent("Gmail");
      await waitFor(() => expect(runAsAccounts).toHaveBeenCalled());
      await act(() => runAsAccounts.mock.results[0]!.value as Promise<unknown>);
      expect(screen.getByTestId("composer-connects")).toHaveTextContent("Gmail");
      expect(runAsAccounts.mock.calls[0]![0]).toMatchObject({
        nodes: [{ id: "trigger", metadata: { trigger: true } }, { id: "send_report" }],
      });
    });

    it("a reattach replaying an ask for a step of an app already connected shows none", async () => {
      useComposer.setState({ connectionNeeds: {} });
      composerAttach.mockImplementation(async function* () {
        yield { event: "connection_needed", data: { node_id: "send_report", provider: "gmail", provider_label: "Gmail" }, seq: 1 };
      });
      runAsAccounts.mockResolvedValue({ steps: [emailMe("only")] });
      render(<ComposerBar workflowId="wf-1" />);

      await waitFor(() => expect(Object.keys(useComposer.getState().connectionNeeds)).toEqual(["send_report"]));
      await waitFor(() => expect(runAsAccounts).toHaveBeenCalled());
      await act(() => runAsAccounts.mock.results[0]!.value as Promise<unknown>);
      expect(screen.queryByTestId("composer-connects")).not.toBeInTheDocument();
    });

    it("the composer's retiring a step's ask takes its chip away", async () => {
      runAsAccounts.mockResolvedValue({ steps: [emailMe("none")] });
      composerAttach.mockImplementation(async function* () {
        yield { event: "connection_resolved", data: { node_id: "send_report" }, seq: 1 };
      });
      render(<ComposerBar workflowId="wf-1" />);

      await waitFor(() => expect(useComposer.getState().connectionNeeds).toEqual({}));
      expect(screen.queryByTestId("composer-connects")).not.toBeInTheDocument();
    });
  });
});
