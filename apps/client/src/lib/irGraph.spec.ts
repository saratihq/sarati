import { describe, expect, it } from "vitest";
import {
  addIrEdge,
  addIrNode,
  countIrEdges,
  deleteIrNode,
  getIrEdges,
  getIrNodes,
  isIrDocument,
  removeIrEdge,
  remapOutgoingMainPorts,
  updateIrNode,
} from "@/lib/irGraph";
import type { IrDocument } from "@/lib/irGraph";

const doc = (nodes: unknown[] = [], edges: unknown[] = []): IrDocument => ({ nodes, edges });

describe("isIrDocument", () => {
  it("accepts the {nodes, edges} shape", () => {
    expect(isIrDocument({ nodes: [], edges: [] })).toBe(true);
  });

  it.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "the legacy {nodes, connections} graph", value: { nodes: [], connections: {} } },
    { label: "a doc with no nodes array", value: { edges: [] } },
  ])("rejects $label", ({ value }) => {
    expect(isIrDocument(value as Record<string, unknown> | null)).toBe(false);
  });

  it("reads a malformed doc as empty rather than throwing", () => {
    const broken = { nodes: "nope", edges: 7 } as unknown as IrDocument;
    expect(getIrNodes(broken)).toEqual([]);
    expect(getIrEdges(broken)).toEqual([]);
    expect(countIrEdges(broken)).toBe(0);
  });
});

describe("addIrEdge", () => {
  it("wires a main edge with the canonical id", () => {
    const next = addIrEdge(doc([{ id: "a" }, { id: "b" }]), "a", "b");
    expect(getIrEdges(next)).toEqual([
      { id: "e-a-b", source_node_id: "a", source_port: 0, target_node_id: "b", target_port: 0, port_type: "main" },
    ]);
  });

  it("puts the port in the id past port 0, so a re-ported edge re-ids like a fresh one", () => {
    expect(getIrEdges(addIrEdge(doc(), "a", "b", 2))[0].id).toBe("e-a-p2-b");
  });

  it("returns the SAME document on a duplicate — callers use identity to skip a re-render", () => {
    const base = addIrEdge(doc(), "a", "b");
    expect(addIrEdge(base, "a", "b")).toBe(base);
  });

  it("lets a router wire several ports to one target — only the full triple dedupes", () => {
    let d = addIrEdge(doc(), "sw", "b", 0);
    d = addIrEdge(d, "sw", "b", 1);
    expect(countIrEdges(d)).toBe(2);
  });

  it("keeps an error edge distinct from the main edge between the same nodes", () => {
    let d = addIrEdge(doc(), "a", "b");
    d = addIrEdge(d, "a", "b", 0, "error");
    expect(getIrEdges(d).map((e) => e.id)).toEqual(["e-a-b", "e-a-err-b"]);
  });

  it("keeps a tool edge distinct too — an agent's binding is its own reviewable edge", () => {
    let d = addIrEdge(doc(), "agent", "tool");
    d = addIrEdge(d, "agent", "tool", 0, "tool");
    expect(getIrEdges(d).map((e) => e.id)).toEqual(["e-agent-tool", "e-agent-tool-tool"]);
    expect(getIrEdges(d).map((e) => e.port_type)).toEqual(["main", "tool"]);
  });
});

describe("removeIrEdge", () => {
  const wired = () => {
    let d = addIrEdge(doc(), "a", "b", 0);
    d = addIrEdge(d, "a", "b", 1);
    return addIrEdge(d, "a", "b", 0, "error");
  };

  it("drops every source→target edge when no port is named", () => {
    expect(countIrEdges(removeIrEdge(wired(), "a", "b"))).toBe(0);
  });

  it("drops only the named port", () => {
    const next = removeIrEdge(wired(), "a", "b", 1);
    expect(getIrEdges(next).map((e) => e.source_port)).toEqual([0, 0]);
  });

  it("drops only the named port type", () => {
    const next = removeIrEdge(wired(), "a", "b", undefined, "error");
    expect(getIrEdges(next).every((e) => e.port_type === "main")).toBe(true);
  });

  it("returns the SAME document when nothing matched", () => {
    const base = wired();
    expect(removeIrEdge(base, "a", "zzz")).toBe(base);
  });
});

describe("remapOutgoingMainPorts", () => {
  const router = () => {
    let d = addIrEdge(doc(), "sw", "case1", 0);
    d = addIrEdge(d, "sw", "case2", 1);
    d = addIrEdge(d, "sw", "fallback", 2);
    d = addIrEdge(d, "sw", "handler", 0, "error");
    return addIrEdge(d, "other", "x", 0);
  };

  it("moves a wire and re-mints its id", () => {
    const next = remapOutgoingMainPorts(router(), "sw", (p) => (p === 2 ? 1 : p === 1 ? null : p));
    const moved = getIrEdges(next).find((e) => e.target_node_id === "fallback");
    expect(moved).toMatchObject({ source_port: 1, id: "e-sw-p1-fallback" });
  });

  it("DROPS the wire when the port is gone, rather than dangling it", () => {
    const next = remapOutgoingMainPorts(router(), "sw", (p) => (p === 1 ? null : p));
    expect(getIrEdges(next).some((e) => e.target_node_id === "case2")).toBe(false);
  });

  it("leaves error edges and other nodes' edges untouched", () => {
    const next = remapOutgoingMainPorts(router(), "sw", () => 0);
    expect(getIrEdges(next).find((e) => e.port_type === "error")).toMatchObject({ id: "e-sw-err-handler" });
    expect(getIrEdges(next).find((e) => e.source_node_id === "other")).toMatchObject({ source_port: 0 });
  });

  it("returns the SAME document when the identity remap changes nothing", () => {
    const base = router();
    expect(remapOutgoingMainPorts(base, "sw", (p) => p)).toBe(base);
  });
});

describe("addIrNode / updateIrNode / deleteIrNode", () => {
  const base = () =>
    addIrEdge(
      doc([
        { id: "a", name: "A", parameters: { to: "x", cc: "y" }, metadata: { trigger: true, note: "keep" } },
        { id: "b", name: "B" },
      ]),
      "a",
      "b",
    );

  it("appends a node without wiring it", () => {
    const next = addIrNode(base(), { id: "c" });
    expect(getIrNodes(next).map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(countIrEdges(next)).toBe(1);
  });

  it("REPLACES parameters wholesale — merging would resurrect a deleted key", () => {
    const next = updateIrNode(base(), "a", { parameters: { to: "z" } });
    expect(getIrNodes(next)[0].parameters).toEqual({ to: "z" });
  });

  it("MERGES metadata — an app trigger's marker must survive an unrelated patch", () => {
    const next = updateIrNode(base(), "a", { metadata: { icon: "gmail" } });
    expect(getIrNodes(next)[0].metadata).toEqual({ trigger: true, note: "keep", icon: "gmail" });
  });

  it("re-types a trigger in place, preserving the node id", () => {
    const next = updateIrNode(base(), "a", { node_type: "orchestr:schedule" });
    expect(getIrNodes(next)[0]).toMatchObject({ id: "a", node_type: "orchestr:schedule", name: "A" });
  });

  it("keeps untouched fields and untouched nodes by REFERENCE", () => {
    const before = base();
    const next = updateIrNode(before, "a", { name: "Renamed" });
    expect(getIrNodes(next)[1]).toBe(getIrNodes(before)[1]);
    expect(getIrNodes(next)[0].parameters).toEqual({ to: "x", cc: "y" });
  });

  it("returns the SAME document when the node does not exist", () => {
    const before = base();
    expect(updateIrNode(before, "missing", { name: "x" })).toBe(before);
  });

  it("removes a node together with every edge into or out of it", () => {
    let d = base();
    d = addIrEdge(d, "b", "a", 0, "error");
    const next = deleteIrNode(d, "a");
    expect(getIrNodes(next).map((n) => n.id)).toEqual(["b"]);
    expect(countIrEdges(next)).toBe(0);
  });
});
