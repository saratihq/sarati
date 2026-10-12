import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ComposeNewWorkflowPage from "@/app/workflows/compose/page";
import { useComposer } from "@/store/useComposer";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/useSessionUserId", () => ({ useSessionUserId: () => "user-1" }));
vi.mock("@/lib/useComposerAvailable", () => ({ useComposerAvailable: () => ({ available: true }) }));
vi.mock("@/components/ComposerBar", () => ({ default: () => null }));
vi.mock("@/components/PreviewPanel", () => ({ default: () => null }));

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
  useComposer.getState().reset();
  useWorkflow.getState().reset();
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
