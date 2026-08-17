import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeTypeEntry } from "@/api/client";
import IrNodeInspector from "@/components/IrNodeInspector";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("./NodeCatalogPanel", () => ({ catalogEntryFor: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { catalogEntryFor } = await import("./NodeCatalogPanel");
const catalogEntry = vi.mocked(catalogEntryFor);

const MESSAGE = "📰 {{story.title}}\n{{story.url}}\n_Disclose you maintain Sarati._";

const entry = (parameters: NodeTypeEntry["parameters"]): NodeTypeEntry =>
  ({ type: "slack.send_channel_message", name: "Send message", parameters }) as NodeTypeEntry;

function seedNode(parameters: Record<string, unknown>): void {
  const doc = {
    version: "1",
    name: "long text",
    nodes: [
      {
        id: "alert",
        name: "alert",
        node_type: "slack.send_channel_message",
        type_version: 1,
        parameters,
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
  };
  // Both documents: an edit is refused unless the store holds an IR doc on each side.
  useWorkflow.setState({ workflowId: null, workflowJson: doc, workflowIr: structuredClone(doc) });
}

const storedParams = (): Record<string, unknown> => {
  const doc = useWorkflow.getState().workflowJson as { nodes: Array<{ parameters: Record<string, unknown> }> };
  return doc.nodes[0]!.parameters;
};

/** The field for `key`, once the catalog schema has landed and settled the control it renders as. */
async function fieldOnceTyped(key: string, tag: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByLabelText(key).tagName).toBe(tag));
  return screen.getByLabelText(key);
}

beforeEach(() => {
  catalogEntry.mockResolvedValue(entry({ text: { type: "LONG_TEXT", label: "Message", required: true } }));
  seedNode({ text: MESSAGE });
});

describe("IrNodeInspector long-text props", () => {
  it("renders a LONG_TEXT prop as a textarea that keeps the value's newlines", async () => {
    render(<IrNodeInspector nodeId="alert" onClose={() => {}} />);

    // An <input> sanitises `\n` out of its value, so the field would show a flattened message.
    const field = await fieldOnceTyped("text", "TEXTAREA");
    expect((field as HTMLTextAreaElement).value).toBe(MESSAGE);
  });

  it("round-trips a multi-line edit back into the document", async () => {
    render(<IrNodeInspector nodeId="alert" onClose={() => {}} />);
    const field = await fieldOnceTyped("text", "TEXTAREA");

    await userEvent.type(field, "{enter}one more line");

    expect(storedParams().text).toBe(`${MESSAGE}\none more line`);
  });

  it("leaves a short-text prop on the single-line input", async () => {
    catalogEntry.mockResolvedValue(entry({ threadTs: { type: "SHORT_TEXT", label: "Thread" } }));
    seedNode({ threadTs: "1710304378.475129" });
    render(<IrNodeInspector nodeId="alert" onClose={() => {}} />);

    expect((await fieldOnceTyped("threadTs", "INPUT")).tagName).toBe("INPUT");
  });
});
