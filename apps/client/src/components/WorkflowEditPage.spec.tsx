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
// The canvas needs a layout engine jsdom lacks; these specs drive the document through the store.
vi.mock("./PreviewPanel", () => ({ default: () => null }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getWorkflow: vi.fn(),
  listVersions: vi.fn(),
  listBranches: vi.fn(),
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
// Longer than the autosave's idle debounce.
const pastAutosave = () => act(() => new Promise((resolve) => setTimeout(resolve, 1000)));

beforeEach(() => {
  useWorkflow.getState().reset();
  vi.mocked(api.getWorkflow).mockResolvedValue({ name: "Report" } as Awaited<ReturnType<typeof api.getWorkflow>>);
  vi.mocked(api.listVersions).mockResolvedValue({
    workflow_id: "wf-1",
    versions: [{ id: "v1", version_number: 1, workflow_json: head }],
  } as Awaited<ReturnType<typeof api.listVersions>>);
  vi.mocked(api.listBranches).mockResolvedValue({
    branches: [{ name: "main", is_protected: false }],
  } as Awaited<ReturnType<typeof api.listBranches>>);
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
    vi.mocked(api.listBranches).mockResolvedValue({
      branches: [{ name: "main", is_protected: true }],
    } as Awaited<ReturnType<typeof api.listBranches>>);
    render(<WorkflowEditPage />);

    expect(await screen.findByText("main is protected · start a branch and open a review to change it")).toBeInTheDocument();
    expect(useWorkflow.getState().editBranchProtected).toBe(true);
    expect(screen.getByRole("button", { name: /Save new version/ })).toBeDisabled();
  });
});
