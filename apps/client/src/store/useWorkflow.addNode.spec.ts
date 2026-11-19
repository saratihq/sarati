import { beforeEach, describe, expect, it } from "vitest";
import type { NodeTypeEntry } from "@/api/client";
import { useWorkflow } from "@/store/useWorkflow";

const codeEntry: NodeTypeEntry = {
  name: "Code",
  type: "orchestr:code",
  category: "control",
  description: "Run a snippet",
  auth: "none",
  parameters: {
    language: { type: "string", required: false, default: "js", options: [{ label: "JavaScript", value: "js" }] },
    code: { type: "string", required: true },
  },
};

beforeEach(() => {
  const doc = { nodes: [], edges: [] };
  useWorkflow.setState({ workflowJson: doc, workflowIr: doc, lastGeneratedJson: doc });
});

describe("adding a Code step from the catalog", () => {
  it("writes no language, so it runs in the one the service names its default", () => {
    useWorkflow.getState().addIrNodeFromCatalog(codeEntry);

    const [node] = (useWorkflow.getState().workflowJson as { nodes: Array<{ parameters: Record<string, unknown> }> }).nodes;
    expect(node?.parameters).toEqual({ code: "// steps holds earlier outputs, trigger the firing event\nreturn steps;" });
  });
});
