import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import type { Connection, NodeTypeEntry, StepAccount } from "@/api/client";
import ConnectCaptureBanner from "@/components/ConnectCaptureBanner";
import IrNodeInspector from "@/components/IrNodeInspector";
import { connectAppWithFeedback } from "@/lib/managedConnect";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("./NodeCatalogPanel", () => ({ catalogEntryFor: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/managedConnect", () => ({ connectAppWithFeedback: vi.fn() }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listConnections: vi.fn(),
  runAsAccounts: vi.fn(),
  connectionAccount: vi.fn(),
  loadNodeTypeOptions: vi.fn(),
}));

const { catalogEntryFor } = await import("./NodeCatalogPanel");
const catalogEntry = vi.mocked(catalogEntryFor);
const listConnections = vi.mocked(api.listConnections);
const runAsAccounts = vi.mocked(api.runAsAccounts);
const connectionAccount = vi.mocked(api.connectionAccount);
const loadNodeTypeOptions = vi.mocked(api.loadNodeTypeOptions);

const gmail = (id: string, email: string): Connection => ({
  id,
  provider: "gmail",
  display_name: null,
  auth_type: "managed",
  status: "active",
  account: { subject: "user", email, id: email, name: null, handle: null },
});
const mine = gmail("conn-mine", "you@e2e.local");
const work = gmail("conn-work", "work@e2e.local");

const answer = (over: Partial<StepAccount>): StepAccount => ({
  node_id: "send_report",
  node_name: "Email me the report",
  app: "gmail",
  state: "only",
  connection_id: mine.id,
  accounts: [mine.id],
  managed_only: false,
  message: null,
  ...over,
});

function openStep(parameters: Record<string, unknown>, { banner = false } = {}): void {
  const doc = {
    version: "1",
    name: "digest",
    nodes: [
      {
        id: "send_report",
        name: "Email me the report",
        node_type: "gmail.send_email",
        type_version: 1,
        parameters: { to: "{{$account.email}}", ...parameters },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
  };
  // A saved head the canvas is measured against: only a real edit may arm Save.
  useWorkflow.setState({
    workflowId: "wf-1",
    workflowJson: doc,
    workflowIr: structuredClone(doc),
    lastGeneratedJson: structuredClone(doc),
    dirty: false,
  });
  render(
    <>
      {banner && <ConnectCaptureBanner />}
      <IrNodeInspector nodeId="send_report" onClose={() => {}} />
    </>,
  );
}

// Longer than the wait before the canvas is asked again.
const settled = () => new Promise((resolve) => setTimeout(resolve, 600));

const none = answer({
  state: "none",
  connection_id: null,
  accounts: [],
  message: 'Step "Email me the report" has no gmail account to run as — connect one',
});

const stored = (): Record<string, unknown> =>
  (useWorkflow.getState().workflowJson as { nodes: Array<{ parameters: Record<string, unknown> }> }).nodes[0]!
    .parameters;

beforeEach(() => {
  vi.clearAllMocks();
  catalogEntry.mockResolvedValue({
    type: "gmail.send_email",
    name: "Send email",
    category: "gmail",
    description: "Send an email.",
    auth: "connection",
    parameters: { to: { type: "SHORT_TEXT", label: "To", required: true } },
  } as NodeTypeEntry);
  listConnections.mockResolvedValue({ connections: [mine, work] });
  connectionAccount.mockResolvedValue({ account: mine.account ?? null } as Awaited<
    ReturnType<typeof api.connectionAccount>
  >);
});

describe("the step's account, as the run would decide it", () => {
  it("opening a step with no account chosen writes nothing, and says it runs as your only one", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer({})] });
    openStep({});

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent(
      "Runs as your only active Gmail account · you@e2e.local",
    );
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("");
    expect(stored().connectionId).toBeUndefined();
    expect(useWorkflow.getState().dirty).toBe(false);
    // The service decides from the step as it stands — the canvas asks, never guesses.
    expect(runAsAccounts.mock.calls[0]![0]).toMatchObject({
      nodes: [{ id: "send_report", node_type: "gmail.send_email", parameters: {} }],
    });
  });

  it("with no account it says so and offers to connect one, still writing nothing", async () => {
    runAsAccounts.mockResolvedValue({
      steps: [
        answer({
          state: "none",
          connection_id: null,
          accounts: [],
          message: 'Step "Email me the report" has no gmail account to run as — connect one',
        }),
      ],
    });
    openStep({});

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent("No Gmail account — connect one");
    expect(screen.getByTestId("connect-app-inline")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
    expect(useWorkflow.getState().dirty).toBe(false);
    // A test of the step would be refused for the same reason the run gives.
    await waitFor(() => expect(screen.getByTestId("test-step-button")).toBeDisabled());
    expect(screen.getByTestId("test-step-connection-block")).toHaveTextContent(
      'Step "Email me the report" has no gmail account to run as — connect one',
    );
  });

  it("connecting the app from the step asks again what it runs as, and still writes nothing", async () => {
    runAsAccounts
      .mockResolvedValueOnce({ steps: [none] })
      .mockResolvedValue({ steps: [answer({ connection_id: "conn-new", accounts: ["conn-new"] })] });
    vi.mocked(connectAppWithFeedback).mockResolvedValue("conn-new");
    openStep({});

    await userEvent.click(await screen.findByTestId("connect-app-inline"));

    await waitFor(() =>
      expect(screen.getByTestId("connection-run-as")).toHaveTextContent("Runs as your only active Gmail account"),
    );
    expect(runAsAccounts).toHaveBeenCalledTimes(2);
    expect(stored().connectionId).toBeUndefined();
    expect(useWorkflow.getState().dirty).toBe(false);
  });

  it("a step's live options load as the account it runs as, chosen or not", async () => {
    catalogEntry.mockResolvedValue({
      type: "gmail.send_email",
      name: "Send email",
      category: "gmail",
      description: "Send an email.",
      auth: "connection",
      parameters: { label: { type: "DROPDOWN", label: "Label", required: true } },
    } as NodeTypeEntry);
    loadNodeTypeOptions.mockResolvedValue({ options: [{ label: "Inbox", value: "INBOX" }], disabled: false });
    runAsAccounts.mockResolvedValue({ steps: [answer({})] });
    openStep({});

    await waitFor(() =>
      expect(loadNodeTypeOptions).toHaveBeenCalledWith("gmail.send_email", { prop: "label", connection_id: mine.id }),
    );
    expect(stored().connectionId).toBeUndefined();
    expect(useWorkflow.getState().dirty).toBe(false);
  });

  it("with several accounts it asks for a pick, and a pick by hand is an ordinary edit that arms Save", async () => {
    runAsAccounts.mockResolvedValue({
      steps: [answer({ state: "several", connection_id: null, accounts: [work.id, mine.id], message: "pick one" })],
    });
    openStep({});

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent("You have 2 active Gmail accounts — pick one");
    expect(useWorkflow.getState().dirty).toBe(false);

    await userEvent.selectOptions(screen.getByLabelText("Account"), work.id);
    expect(stored().connectionId).toBe(work.id);
    expect(useWorkflow.getState().dirty).toBe(true);
  });

  it("a stored account that isn't yours shows as stale, never as your first live account", async () => {
    runAsAccounts.mockResolvedValue({
      steps: [answer({ state: "stale", connection_id: null, accounts: [mine.id], message: "stale" })],
    });
    openStep({ connectionId: "conn-teammates" });

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent(
      "This step's account was removed or isn't yours — pick one",
    );
    const select = screen.getByLabelText("Account") as HTMLSelectElement;
    expect(select.value).toBe("conn-teammates");
    expect(select.selectedOptions[0]!.textContent).toBe("This step's account was removed or isn't yours — pick one");
    expect(select.selectedOptions[0]!.disabled).toBe(true);
    expect(useWorkflow.getState().dirty).toBe(false);

    // Clearing the choice is an edit too: the step goes back to being decided when it runs.
    await userEvent.selectOptions(select, "");
    expect(stored()).not.toHaveProperty("connectionId");
    expect(useWorkflow.getState().dirty).toBe(true);
  });

  it("a chosen account for another app shows as what it is, never as this app's, and holds the step's test", async () => {
    const message =
      'Step "Email me the report" runs as an account for slack, not gmail — pick one of your gmail accounts on the step';
    runAsAccounts.mockResolvedValue({
      steps: [answer({ state: "wrong_app", connection_id: null, accounts: [mine.id], message })],
    });
    openStep({ connectionId: "conn-slack" });

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent(
      "This step's account is for another app, not Gmail — pick one",
    );
    const select = screen.getByLabelText("Account") as HTMLSelectElement;
    expect(select.value).toBe("conn-slack");
    expect(select.selectedOptions[0]!.textContent).toBe("This step's account is for another app, not Gmail — pick one");
    expect(select.selectedOptions[0]!.disabled).toBe(true);
    expect(screen.queryByText(/The Gmail account chosen here/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-account-line")).not.toBeInTheDocument();
    expect(await screen.findByTestId("test-step-connection-block")).toHaveTextContent(message);
    expect(screen.getByTestId("test-step-button")).toBeDisabled();
    expect(useWorkflow.getState().dirty).toBe(false);
  });

  it("a chosen account of yours that isn't active says so and how to fix it, as the run would", async () => {
    runAsAccounts.mockResolvedValue({
      steps: [
        answer({
          state: "inactive",
          connection_id: null,
          accounts: [mine.id],
          message:
            "Step \"Email me the report\" runs as a gmail account that isn't active — pick another of your gmail accounts on the step",
        }),
      ],
    });
    openStep({ connectionId: "conn-pending" });

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent(
      "This step's Gmail account isn't active — pick another of your Gmail accounts",
    );
    const select = screen.getByLabelText("Account") as HTMLSelectElement;
    expect(select.value).toBe("conn-pending");
    expect(select.selectedOptions[0]!.textContent).toBe("The Gmail account chosen here (not active)");
    expect(screen.queryByTestId("connection-account-line")).not.toBeInTheDocument();
    expect(useWorkflow.getState().dirty).toBe(false);
  });

  it("a step only one-click accounts run says so wherever it counts them", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer({ managed_only: true })] });
    openStep({});

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent(
      "Runs as your only active one-click Gmail account · you@e2e.local",
    );
    expect(screen.getByTestId("connection-field")).toHaveTextContent(
      "With none chosen it runs as your only active one-click Gmail account, and a promoted run uses its environment's.",
    );
  });

  it("a step only one-click accounts run, holding one with its own credentials, shows what it holds and holds the test", async () => {
    const message =
      'Step "Email me the report" runs as an account that uses its own credentials, and it runs only on a one-click (managed) gmail account — pick one on the step, or connect one under Integrations';
    runAsAccounts.mockResolvedValue({
      steps: [answer({ state: "needs_managed", connection_id: null, accounts: [mine.id], managed_only: true, message })],
    });
    openStep({ connectionId: "conn-own" });

    const held = "This step's account uses its own credentials, and it runs only on a one-click Gmail account — pick one";
    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent(held);
    const select = screen.getByLabelText("Account") as HTMLSelectElement;
    expect(select.value).toBe("conn-own");
    expect(select.selectedOptions[0]!.textContent).toBe(held);
    expect(select.selectedOptions[0]!.disabled).toBe(true);
    expect(await screen.findByTestId("test-step-connection-block")).toHaveTextContent(message);
    expect(screen.getByTestId("test-step-button")).toBeDisabled();
  });

  it("the help line reads as words on any step", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer({})] });
    openStep({});
    expect(await screen.findByTestId("connection-field")).toHaveTextContent(
      "With none chosen it runs as your only active Gmail account, and a promoted run uses its environment's.",
    );
  });

  it("an AI Agent's help line says a promoted run always uses its slot, and a pick pins only a Default run", async () => {
    const claude: Connection = { ...mine, id: "conn-claude", provider: "claude", auth_type: "byo", account: null };
    listConnections.mockResolvedValue({ connections: [claude] });
    runAsAccounts.mockResolvedValue({
      steps: [
        answer({ node_id: "think", node_name: "Think it over", app: "claude", connection_id: claude.id, accounts: [claude.id] }),
      ],
    });
    const doc = {
      version: "1",
      name: "digest",
      nodes: [
        {
          id: "think",
          name: "Think it over",
          node_type: "orchestr:agent",
          type_version: 1,
          parameters: { model: { provider: "claude", model: "claude-opus-4-8" } },
          position: { x: 0, y: 0 },
          metadata: {},
        },
      ],
      edges: [],
    };
    useWorkflow.setState({
      workflowId: "wf-1",
      workflowJson: doc,
      workflowIr: structuredClone(doc),
      lastGeneratedJson: structuredClone(doc),
      dirty: false,
    });
    render(<IrNodeInspector nodeId="think" onClose={() => {}} />);

    expect(await screen.findByTestId("connection-field")).toHaveTextContent(
      "Optional — with none chosen the model runs on your only active Claude account, and a promoted run always on its environment's claude slot (the same kind of connection the LLM steps use). Picking one pins only a Default run. Manage accounts in Integrations.",
    );
  });

  it("an account chosen by hand shows which account it is", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer({ state: "chosen", connection_id: mine.id })] });
    openStep({ connectionId: mine.id });

    expect(await screen.findByTestId("connection-account-line")).toHaveTextContent(
      "Authorized against you@e2e.local.",
    );
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe(mine.id);
    expect(screen.queryByTestId("connection-run-as")).not.toBeInTheDocument();
  });

  it("with no account chosen, Me is the account it runs as — offered to send to, and previewed", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer({})] });
    openStep({ to: "" });

    expect(await screen.findByTestId("send-to-me")).toHaveTextContent("Send to me · you@e2e.local");
    await userEvent.click(screen.getByTestId("send-to-me"));
    expect(stored().to).toBe("{{$account.email}}");
    expect(await screen.findByTestId("ref-preview")).toHaveTextContent("→ you@e2e.local");
  });

  it("with no account to run as there is no Me to offer", async () => {
    runAsAccounts.mockResolvedValue({
      steps: [answer({ state: "several", connection_id: null, accounts: [work.id, mine.id], message: "pick one" })],
    });
    openStep({ to: "" });

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent("You have 2 active Gmail accounts — pick one");
    expect(screen.queryByTestId("send-to-me")).not.toBeInTheDocument();
  });

  it("one ask serves the banner and the step, and renaming the step asks nothing more", async () => {
    runAsAccounts.mockResolvedValue({ steps: [none] });
    openStep({}, { banner: true });

    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent("No Gmail account — connect one");
    expect(screen.getByTestId("connect-capture-banner")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Step title"), " weekly");
    await settled();

    expect(runAsAccounts).toHaveBeenCalledTimes(1);
    // The refusal names the step as it is called now, as a run would.
    expect(screen.getByTestId("test-step-connection-block")).toHaveTextContent(
      'Step "Email me the report weekly" has no gmail account to run as — connect one',
    );
  });

  it("a pick asks once more, and only after it settles", async () => {
    runAsAccounts.mockResolvedValue({
      steps: [answer({ state: "several", connection_id: null, accounts: [work.id, mine.id], message: "pick one" })],
    });
    openStep({});
    expect(await screen.findByTestId("connection-run-as")).toHaveTextContent("You have 2 active Gmail accounts — pick one");

    runAsAccounts.mockResolvedValue({ steps: [answer({ state: "chosen", connection_id: work.id, accounts: [work.id, mine.id] })] });
    await userEvent.selectOptions(screen.getByLabelText("Account"), work.id);
    expect(runAsAccounts).toHaveBeenCalledTimes(1);
    // The pick stays on screen while it settles; only what it runs as waits for the answer.
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe(work.id);
    expect(screen.queryByTestId("connection-run-as")).not.toBeInTheDocument();

    expect(await screen.findByTestId("connection-account-line")).toBeInTheDocument();
    expect(runAsAccounts).toHaveBeenCalledTimes(2);
    expect(runAsAccounts.mock.calls[1]![0]).toMatchObject({
      nodes: [{ id: "send_report", parameters: { connectionId: work.id } }],
    });
  });
});
