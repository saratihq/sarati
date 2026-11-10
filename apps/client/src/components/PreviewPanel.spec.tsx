import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeTypeEntry } from "@/api/client";
import { BranchMovedDialog } from "@/components/BranchMovedDialog";
import PreviewPanel from "@/components/PreviewPanel";
import { useWorkflow } from "@/store/useWorkflow";

interface CanvasProps {
  workflowJson?: { nodes?: Array<{ id: string; name: string }> } | null;
  onNodeClick?: (id: string, data: { name: string; type: string }) => void;
  onCanvasClick?: () => void;
  selectNodeIds?: string[];
  selectNonce?: number;
}

const canvas = vi.hoisted(() => ({ last: {} as CanvasProps }));

// React Flow needs a layout engine jsdom lacks; the stub keeps the props PreviewPanel wires into it.
vi.mock("./FlowCanvas", () => ({
  default: (props: CanvasProps) => {
    canvas.last = props;
    return (
      <div>
        {(props.workflowJson?.nodes ?? []).map((n) => (
          <button key={n.id} type="button" onClick={() => props.onNodeClick?.(n.id, { name: n.name, type: "" })}>
            {`Card ${n.id}`}
          </button>
        ))}
        <button type="button" onClick={() => props.onCanvasClick?.()}>
          Empty canvas
        </button>
      </div>
    );
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// CodeMirror measures text through Range rects, which jsdom does not lay out.
Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const CATALOG = [
  { type: "http.get", name: "Fetch a page", category: "HTTP", description: "", parameters: {} },
  { type: "orchestr:code", name: "Code", category: "Core", description: "", parameters: {} },
  {
    type: "slack.send_channel_message",
    name: "Send message",
    category: "Slack",
    description: "",
    parameters: { text: { type: "SHORT_TEXT", label: "Message", required: true } },
  },
] as unknown as NodeTypeEntry[];

// The service over `fetch`: the step catalog, an empty account list and run-as answer; anything else 404s.
function stubService(): void {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);
      const method = init?.method ?? "GET";
      if (method === "GET" && pathname === "/api/node-types") return json(200, { node_types: CATALOG });
      if (method === "GET" && pathname === "/api/connections") return json(200, []);
      if (method === "POST" && pathname === "/api/connections/run-as") return json(200, { steps: [] });
      return json(404, { detail: "Not Found" });
    }),
  );
}

function openDoc(): void {
  const doc = {
    version: "1",
    name: "Escape",
    nodes: [
      { id: "fetch", name: "Fetch", node_type: "http.get", parameters: {} },
      { id: "alert", name: "Alert", node_type: "slack.send_channel_message", parameters: { text: "" } },
      { id: "shape", name: "Shape", node_type: "orchestr:code", parameters: { language: "js", code: "return steps;" } },
    ].map((n) => ({ type_version: 1, position: { x: 0, y: 0 }, metadata: {}, ...n })),
    edges: [{ id: "e1", source_node_id: "fetch", target_node_id: "alert" }],
  };
  useWorkflow.setState({ workflowId: null, workflowJson: doc, workflowIr: structuredClone(doc) });
}

const inspector = () => screen.queryByRole("button", { name: "Close inspector" });
const catalog = () => screen.queryByRole("textbox", { name: "Search the step catalog" });

async function openInspector(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Card alert" }));
  await screen.findByRole("textbox", { name: "text" });
}

beforeEach(() => {
  useWorkflow.getState().reset();
  stubService();
  openDoc();
});

describe("PreviewPanel side panel", () => {
  it.each([
    ["the composer canvas", true],
    ["the classic editor", false],
  ])("+ Add step over an open step on %s shows the catalog in its place", async (_, bare) => {
    render(<PreviewPanel bare={bare} />);
    await openInspector();

    await userEvent.click(screen.getByRole("button", { name: "+ Add step" }));

    expect(await screen.findByRole("textbox", { name: "Search the step catalog" })).toBeInTheDocument();
    expect(inspector()).toBeNull();
    await userEvent.click(screen.getByText("Close catalog"));
    expect(catalog()).toBeNull();
    expect(inspector()).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add step" })).toBeInTheDocument();
  });

  it.each([
    ["the step's card", () => screen.getByRole("button", { name: "Card alert" }).focus()],
    ["one of its fields", () => screen.getByRole("textbox", { name: "text" }).focus()],
    ["nothing", () => (document.activeElement as HTMLElement | null)?.blur()],
  ])("Escape with focus on %s closes the inspector and clears the canvas selection", async (_, focus) => {
    render(<PreviewPanel bare />);
    await openInspector();
    const nonce = canvas.last.selectNonce ?? 0;

    act(focus);
    await userEvent.keyboard("{Escape}");

    expect(inspector()).toBeNull();
    expect(canvas.last.selectNodeIds).toEqual([]);
    expect(canvas.last.selectNonce).toBe(nonce + 1);
  });

  it.each([
    ["on the menu's button", () => screen.getByRole("button", { name: "Insert data from an earlier step" }).focus()],
    ["dropped to the page", () => (document.activeElement as HTMLElement | null)?.blur()],
  ])("Escape with the field menu open and focus %s closes only the menu", async (_, focus) => {
    render(<PreviewPanel bare />);
    await openInspector();
    await userEvent.click(screen.getByRole("button", { name: "Insert data from an earlier step" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(focus);
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(inspector()).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(inspector()).toBeNull();
  });

  it("Escape closes the catalog", async () => {
    render(<PreviewPanel bare />);
    await userEvent.click(screen.getByRole("button", { name: "+ Add step" }));
    expect(catalog()).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(catalog()).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add step" })).toBeInTheDocument();
  });

  it("Escape in the version-comment input outside the editor leaves the inspector open", async () => {
    render(
      <>
        <input aria-label="Version comment" />
        <PreviewPanel bare />
      </>,
    );
    await openInspector();

    await userEvent.click(screen.getByRole("textbox", { name: "Version comment" }));
    await userEvent.keyboard("{Escape}");

    expect(inspector()).toBeInTheDocument();
  });

  it.each([
    ["inside it", () => {}],
    ["dropped to the page", () => (document.activeElement as HTMLElement | null)?.blur()],
  ])("Escape with a page dialog open and focus %s dismisses only the dialog", async (_, focus) => {
    render(
      <>
        <PreviewPanel bare />
        <BranchMovedDialog />
      </>,
    );
    await openInspector();
    act(() =>
      useWorkflow.setState({
        branchMoved: { currentHeadVersionId: "v2", currentHeadVersionNumber: 2, baseVersionId: "v1" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alertdialog")).toContainElement(document.activeElement as HTMLElement),
    );

    act(focus);
    await userEvent.keyboard("{Escape}");

    expect(useWorkflow.getState().branchMoved).toBeNull();
    expect(inspector()).toBeInTheDocument();
  });

  it("Escape in the code editor stays with it, so Escape then Tab still moves focus out", async () => {
    render(<PreviewPanel bare />);
    await userEvent.click(screen.getByRole("button", { name: "Card shape" }));
    const editor = await screen.findByTestId("code-editor", {}, { timeout: 3000 });
    await waitFor(() => expect(editor.querySelector(".cm-content")).not.toBeNull());
    const code = editor.querySelector<HTMLElement>(".cm-content")!;

    act(() => code.focus());
    // CodeMirror reads keyCode, which user-event leaves unset; an unprevented Tab is the browser's focus move.
    const tab = () => fireEvent.keyDown(code, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(tab()).toBe(false);
    fireEvent.keyDown(code, { key: "Escape", code: "Escape", keyCode: 27 });

    expect(inspector()).toBeInTheDocument();
    expect(tab()).toBe(true);
  });

  it("a pane click and the inspector's close button empty the slot", async () => {
    render(<PreviewPanel bare />);
    await openInspector();
    await userEvent.click(screen.getByRole("button", { name: "Empty canvas" }));
    expect(inspector()).toBeNull();

    await openInspector();
    await userEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(inspector()).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add step" })).toBeInTheDocument();
  });
});
