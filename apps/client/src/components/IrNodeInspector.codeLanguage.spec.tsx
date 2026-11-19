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

/** The Code row as `/api/node-types` serves it: the languages the sandbox runs, and the one a step naming none runs in. */
const CODE_ROW = {
  type: "orchestr:code",
  name: "Code",
  parameters: {
    language: {
      type: "string",
      required: false,
      default: "js",
      options: [
        { label: "JavaScript", value: "js" },
        { label: "TypeScript", value: "ts" },
      ],
    },
    code: { type: "string", required: true },
  },
} as unknown as NodeTypeEntry;

function seedCode(parameters: Record<string, unknown>): void {
  const doc = {
    version: "1",
    name: "code",
    nodes: [
      {
        id: "calc",
        name: "calc",
        node_type: "orchestr:code",
        type_version: 1,
        parameters: { code: "return 1;", ...parameters },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
  };
  useWorkflow.setState({ workflowId: null, workflowJson: doc, workflowIr: structuredClone(doc) });
}

const storedParams = (): Record<string, unknown> => {
  const doc = useWorkflow.getState().workflowJson as { nodes: Array<{ parameters: Record<string, unknown> }> };
  return doc.nodes[0]!.parameters;
};

async function languageSelect(): Promise<HTMLSelectElement> {
  const select = screen.getByTestId("code-language-select") as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  return select;
}

const shown = (select: HTMLSelectElement): string => select.selectedOptions[0]?.textContent ?? "";

beforeEach(() => {
  catalogEntry.mockResolvedValue(CODE_ROW);
});

describe("IrNodeInspector Code step language", () => {
  it("shows a stored language the sandbox does not run as itself, writes nothing on open, and picking JavaScript writes it", async () => {
    seedCode({ language: "python" });
    render(<IrNodeInspector nodeId="calc" onClose={() => {}} />);
    const select = await languageSelect();

    expect(shown(select)).toBe("python (not supported)");
    expect(select.selectedOptions[0]?.disabled).toBe(true);
    expect(screen.getByText("This step won't save or run in this language — pick JavaScript or TypeScript.")).toBeTruthy();
    expect(storedParams().language).toBe("python");

    await userEvent.selectOptions(select, "js");

    expect(storedParams().language).toBe("js");
    expect(shown(select)).toBe("JavaScript");
  });

  it("shows a stored value that is no plain name as it is written, never as a blank", async () => {
    for (const [language, label] of [
      ["", '"" (not supported)'],
      [5, "5 (not supported)"],
      [" js", '" js" (not supported)'],
    ] as const) {
      seedCode({ language });
      const { unmount } = render(<IrNodeInspector nodeId="calc" onClose={() => {}} />);
      expect(shown(await languageSelect())).toBe(label);
      expect(storedParams().language).toBe(language);
      unmount();
    }
  });

  it("offers the languages the service serves, a step naming none showing the served default", async () => {
    for (const parameters of [{}, { language: null }]) {
      seedCode(parameters);
      const { unmount } = render(<IrNodeInspector nodeId="calc" onClose={() => {}} />);
      const select = await languageSelect();

      expect(Array.from(select.options, (o) => o.textContent)).toEqual(["JavaScript", "TypeScript"]);
      expect(shown(select)).toBe("JavaScript");
      expect(storedParams()).toEqual({ code: "return 1;", ...parameters });

      await userEvent.selectOptions(select, "ts");
      expect(storedParams().language).toBe("ts");
      unmount();
    }
  });

  it("offers exactly what the service serves, nothing of its own", async () => {
    const jsOnly = structuredClone(CODE_ROW);
    jsOnly.parameters.language!.options = [{ label: "JavaScript", value: "js" }];
    catalogEntry.mockResolvedValue(jsOnly);
    seedCode({ language: "ts" });
    render(<IrNodeInspector nodeId="calc" onClose={() => {}} />);
    const select = await languageSelect();

    expect(Array.from(select.options, (o) => o.textContent)).toEqual(["ts (not supported)", "JavaScript"]);
  });

  it("says so when the languages could not be loaded, and offers none to pick", async () => {
    catalogEntry.mockResolvedValue(null);
    seedCode({ language: "ts" });
    render(<IrNodeInspector nodeId="calc" onClose={() => {}} />);

    await screen.findByText("Couldn't load the languages — close this step and open it again to retry.");
    const select = screen.getByTestId("code-language-select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(storedParams().language).toBe("ts");
  });
});
