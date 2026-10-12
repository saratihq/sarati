import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import * as api from "@/api/client";
import ComposeNewWorkflowPage from "@/app/workflows/compose/page";
import { useComposer } from "@/store/useComposer";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/useSessionUserId", () => ({ useSessionUserId: () => "user-1" }));
vi.mock("@/lib/useComposerAvailable", () => ({ useComposerAvailable: () => ({ available: true }) }));
vi.mock("@/components/ComposerBar", () => ({ default: () => null }));
vi.mock("@/components/PreviewPanel", () => ({ default: () => null }));
vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerAttach: vi.fn(),
  composerStream: vi.fn(),
  refreshSessionToken: vi.fn(),
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  deployWorkflow: vi.fn(),
  listNodeTypes: vi.fn(),
}));

const step = (id: string, name: string) => ({
  id,
  name,
  node_type: "orchestr:code",
  type_version: 1,
  parameters: { language: "js", code: "return 1;" },
  position: { x: 300, y: 300 },
  metadata: {},
});
const trigger = {
  id: "trigger",
  name: "Trigger",
  node_type: "orchestr:trigger",
  type_version: 1,
  parameters: {},
  position: { x: 60, y: 300 },
  metadata: {},
};
const docOf = (nodes: unknown[]) => ({ version: "1", name: "Digest", nodes, edges: [] });
const draftKey = "orchestr:draft:user-1:scratch";
const unsaved = {
  ir: docOf([trigger, step("build_digest", "Build the digest")]),
  name: "Digest",
  savedAt: "2026-10-01T09:00:00.000Z",
};
const ids = () => (useWorkflow.getState().workflowJson as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id);
const storedDraft = (): unknown => JSON.parse(localStorage.getItem(draftKey) ?? "null");
// Longer than the autosave's idle debounce.
const pastAutosave = () => act(() => new Promise((resolve) => setTimeout(resolve, 1000)));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useComposer.getState().reset();
  useWorkflow.getState().reset();
  vi.mocked(agent.composerStream).mockImplementation(async function* () {});
  vi.mocked(api.listNodeTypes).mockResolvedValue({
    node_types: [
      {
        name: "Send an email",
        type: "gmail.send_email",
        category: "Gmail",
        description: "",
        auth: "oauth2",
        parameters: { to: { type: "STRING", required: true }, subject: { type: "STRING", required: true } },
      },
    ],
  });
});

describe("the compose page with a stored draft", () => {
  it("never writes over it before the person answers, even when a composer batch lands meanwhile", async () => {
    localStorage.setItem(draftKey, JSON.stringify(unsaved));
    render(<ComposeNewWorkflowPage />);
    await screen.findByText("Resume your draft?");

    act(() => useWorkflow.getState().resumeDraftIr(docOf([trigger, step("send", "Send it")])));
    await pastAutosave();
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(storedDraft()).toEqual(unsaved);

    await userEvent.click(screen.getByRole("button", { name: "Continue draft" }));
    expect(ids()).toEqual(["trigger", "build_digest"]);
  });

  it("once the person answers, the canvas is kept as a draft again", async () => {
    localStorage.setItem(draftKey, JSON.stringify(unsaved));
    render(<ComposeNewWorkflowPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Start fresh" }));
    expect(ids()).toEqual(["trigger"]);

    act(() => useWorkflow.getState().resumeDraftIr(docOf([trigger, step("send", "Send it")])));
    await pastAutosave();
    await waitFor(() => expect(storedDraft()).toMatchObject({ ir: docOf([trigger, step("send", "Send it")]) }));
  });
});

describe("the composer's offer to save, on the compose page", () => {
  const sendReport = (subject: string) => ({
    id: "send_report",
    name: "Email me the report",
    node_type: "gmail.send_email",
    type_version: 1,
    parameters: { to: "{{$account.email}}", subject },
    position: { x: 600, y: 300 },
    metadata: {},
  });
  const lastNote = () => vi.mocked(agent.composerStream).mock.calls.at(-1)?.[0].message;

  it("replayed onto a blank canvas creates nothing, says why, and tells the composer its draft isn't there", async () => {
    render(<ComposeNewWorkflowPage />);
    await waitFor(() => expect(ids()).toEqual(["trigger"]));
    const built = docOf([trigger, step("build_digest", "Build the digest"), sendReport("Digest")]);
    vi.mocked(agent.composerAttach).mockImplementationOnce(async function* () {
      yield { event: "session", data: { session_id: "s-1" }, seq: 6 } as agent.SequencedComposerEvent;
      yield { event: "user_message", data: { text: "Email me a daily digest" }, seq: 1 } as agent.SequencedComposerEvent;
      yield { event: "op_applied", data: { ops: [], ir: built }, seq: 2 } as agent.SequencedComposerEvent;
      yield { event: "assistant_text", data: { text: "It's built and tested — want me to save it?" }, seq: 3 } as agent.SequencedComposerEvent;
      yield { event: "offer", data: { offer_id: "o1" }, seq: 4 } as agent.SequencedComposerEvent;
      yield { event: "done", data: { session_id: "s-1", duration_ms: 1 }, seq: 5 } as agent.SequencedComposerEvent;
      yield { event: "replayed", data: {}, seq: 5 } as agent.SequencedComposerEvent;
    });
    await act(() => useComposer.getState().attach());
    expect(useComposer.getState().offerPending).toBe(true);
    expect(ids()).toEqual(["trigger"]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(() => useComposer.getState().acceptOffer("live"));

    expect(api.deployWorkflow).not.toHaveBeenCalled();
    expect(useWorkflow.getState().workflowId).toBeNull();
    expect(useComposer.getState().failure).toBe("Nothing was created: the canvas has no steps yet.");
    expect(lastNote()).toBe(
      "(canvas note) Nothing was created — the canvas has no step beyond the trigger, so it doesn't hold your draft.",
    );
  });

  it("refuses a canvas with a required field empty, as the header's Save does", async () => {
    render(<ComposeNewWorkflowPage />);
    await waitFor(() => expect(ids()).toEqual(["trigger"]));
    act(() => useWorkflow.getState().resumeDraftIr(docOf([trigger, sendReport("")])));
    expect(await screen.findByText("1 required field missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(() => useComposer.getState().acceptOffer("live"));

    expect(api.deployWorkflow).not.toHaveBeenCalled();
    expect(useComposer.getState().failure).toBe("Nothing was created: 1 required field is empty.");
    expect(lastNote()).toBe(
      "(canvas note) Nothing was created — required fields are empty on the canvas: Email me the report (subject).",
    );
  });
});
