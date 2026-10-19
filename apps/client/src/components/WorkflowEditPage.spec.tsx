import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import WorkflowEditPage from "@/components/WorkflowEditPage";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "wf-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/useSessionUserId", () => ({ useSessionUserId: () => "user-1" }));
vi.mock("@/lib/useComposerAvailable", () => ({ useComposerAvailable: () => ({ available: false }) }));
// The canvas itself needs a layout engine jsdom lacks; the banner is the part that reads the document.
vi.mock("./PreviewPanel", async () => {
  const { default: ConnectCaptureBanner } = await import("./ConnectCaptureBanner");
  return { default: () => <ConnectCaptureBanner /> };
});
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getWorkflow: vi.fn(),
  listVersions: vi.fn(),
  listBranches: vi.fn(),
  commitVersion: vi.fn(),
  composeMerge: vi.fn(),
  listNodeTypes: vi.fn(),
  runAsAccounts: vi.fn(),
}));

const step = (to: string) => ({
  id: "send_report",
  name: "Email the report",
  node_type: "gmail.send_email",
  type_version: 1,
  parameters: { to },
  position: { x: 0, y: 0 },
  metadata: {},
});
const docOf = (to: string) => ({ version: "1", name: "Report", nodes: [step(to)], edges: [] });
const head = docOf("ops@example.test");
const draftKey = "orchestr:draft:user-1:wf-1";
const unsaved = { ir: docOf("my-unsaved-edit@example.test"), name: "Report", savedAt: "2026-10-01T09:00:00.000Z" };

const recipient = (): unknown =>
  (useWorkflow.getState().workflowJson as ReturnType<typeof docOf>).nodes[0]!.parameters.to;
const storedDraft = (): unknown => JSON.parse(localStorage.getItem(draftKey) ?? "null");
const params = (): Record<string, unknown> =>
  (useWorkflow.getState().workflowJson as ReturnType<typeof docOf>).nodes[0]!.parameters as Record<string, unknown>;
// Longer than the autosave's idle debounce.
const pastAutosave = () => act(() => new Promise((resolve) => setTimeout(resolve, 1000)));
const branchIsProtected = (isProtected: boolean) =>
  vi.mocked(api.listBranches).mockResolvedValue({
    branches: [{ name: "main", is_protected: isProtected }],
  } as Awaited<ReturnType<typeof api.listBranches>>);
const runsAs = (state: api.StepAccountState, accounts: string[]) =>
  vi.mocked(api.runAsAccounts).mockResolvedValue({
    steps: [
      {
        node_id: "send_report",
        node_name: "Email the report",
        app: "gmail",
        state,
        connection_id: state === "only" ? accounts[0]! : null,
        accounts,
        managed_only: false,
        message: state === "only" ? null : 'Step "Email the report" has no gmail account to run as — connect one',
      },
    ],
  });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useWorkflow.getState().reset();
  vi.mocked(api.getWorkflow).mockResolvedValue({ name: "Report" } as Awaited<ReturnType<typeof api.getWorkflow>>);
  vi.mocked(api.listVersions).mockResolvedValue({
    workflow_id: "wf-1",
    versions: [{ id: "v1", version_number: 1, workflow_json: head }],
  } as Awaited<ReturnType<typeof api.listVersions>>);
  branchIsProtected(false);
  runsAs("only", ["conn-gmail"]);
  vi.mocked(api.listNodeTypes).mockResolvedValue({
    node_types: [
      {
        name: "Send an email",
        type: "gmail.send_email",
        category: "Gmail",
        description: "",
        auth: "oauth2",
        parameters: { to: { type: "STRING", required: true } },
      },
    ],
  });
});

describe("WorkflowEditPage writes nothing for the person on open", () => {
  it.each([false, true])(
    "a step with no account chosen stays so — no unsaved changes, no draft (protected: %s)",
    async (isProtected) => {
      branchIsProtected(isProtected);
      render(<WorkflowEditPage />);
      await waitFor(() => expect(api.runAsAccounts).toHaveBeenCalled());
      await pastAutosave();

      expect(params().connectionId).toBeUndefined();
      expect(useWorkflow.getState().dirty).toBe(false);
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
      expect(localStorage.getItem(draftKey)).toBeNull();
    },
  );

  it("with no account to run as, the banner offers to connect one — and still writes nothing", async () => {
    runsAs("none", []);
    render(<WorkflowEditPage />);

    expect(await screen.findByTestId("connect-capture-banner")).toHaveTextContent(
      "1 app needs connecting — those steps will run as the account you connect.",
    );
    expect(screen.getByTestId("connect-app-gmail")).toHaveTextContent("Connect Gmail");
    await pastAutosave();
    expect(params().connectionId).toBeUndefined();
    expect(useWorkflow.getState().dirty).toBe(false);
  });
});

describe("WorkflowEditPage with a stored draft", () => {
  it("never writes over it before the person answers, even when the canvas changes meanwhile", async () => {
    localStorage.setItem(draftKey, JSON.stringify(unsaved));
    const first = render(<WorkflowEditPage />);
    await screen.findByText("Resume your draft?");

    // A composer turn the editor rejoined lands a batch while the question is open.
    act(() => useWorkflow.getState().resumeDraftIr(docOf("composer@example.test")));
    expect(useWorkflow.getState().dirty).toBe(true);
    await pastAutosave();
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(storedDraft()).toEqual(unsaved);

    first.unmount();
    render(<WorkflowEditPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue draft" }));
    expect(recipient()).toBe("my-unsaved-edit@example.test");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("once the person answers, their edits are kept as a draft again", async () => {
    localStorage.setItem(draftKey, JSON.stringify(unsaved));
    render(<WorkflowEditPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Start fresh" }));
    expect(recipient()).toBe("ops@example.test");
    expect(localStorage.getItem(draftKey)).toBeNull();

    act(() => useWorkflow.getState().updateIrNode("send_report", { parameters: { to: "new@example.test" } }));
    await pastAutosave();
    await waitFor(() => expect(storedDraft()).toMatchObject({ ir: docOf("new@example.test") }));
  });
});

describe("WorkflowEditPage on a protected branch", () => {
  it("tells the store its canvas can't be saved, so nothing writes to it for the person", async () => {
    branchIsProtected(true);
    render(<WorkflowEditPage />);

    expect(await screen.findByText("main is protected · start a branch and open a review to change it")).toBeInTheDocument();
    expect(useWorkflow.getState().editBranchProtected).toBe(true);
    expect(screen.getByRole("button", { name: /Save new version/ })).toBeDisabled();
  });
});

describe("WorkflowEditPage when a save finds nothing new", () => {
  const editRecipient = () =>
    act(() => useWorkflow.getState().updateIrNode("send_report", { parameters: { to: "new@example.test" } }));

  it("says in the header which version already holds the canvas, until the next edit", async () => {
    render(<WorkflowEditPage />);
    await screen.findByText("Editing the live workflow · saves commit a new version on Sarati");
    editRecipient();
    vi.mocked(api.commitVersion).mockResolvedValue({
      id: "v1",
      version_number: 1,
      no_changes: true,
    } as Awaited<ReturnType<typeof api.commitVersion>>);

    await userEvent.click(screen.getByRole("button", { name: /Save new version/ }));

    expect(await screen.findByText("Already saved as v1")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    act(() => useWorkflow.getState().updateIrNode("send_report", { parameters: { to: "other@example.test" } }));
    expect(screen.queryByText("Already saved as v1")).toBeNull();
  });

  it("says so after a rebase that lands on what the moved-on head already holds", async () => {
    render(<WorkflowEditPage />);
    await screen.findByText("Editing the live workflow · saves commit a new version on Sarati");
    editRecipient();
    const mine = useWorkflow.getState().workflowJson!;
    act(() =>
      useWorkflow.setState({
        branchMoved: { currentHeadVersionId: "v2", currentHeadVersionNumber: 2, baseVersionId: "v1" },
      }),
    );
    vi.mocked(api.listVersions).mockResolvedValue({
      workflow_id: "wf-1",
      versions: [
        { id: "v1", version_number: 1, workflow_json: head },
        { id: "v2", version_number: 2, workflow_json: mine },
      ],
    } as Awaited<ReturnType<typeof api.listVersions>>);
    vi.mocked(api.composeMerge).mockResolvedValue({ merged: mine, conflicts: [] });

    await userEvent.click(await screen.findByRole("button", { name: "Rebase onto latest" }));

    expect(await screen.findByText("Already saved as v2")).toBeInTheDocument();
    expect(api.commitVersion).not.toHaveBeenCalled();
  });
});
