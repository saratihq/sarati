import { describe, expect, it } from "vitest";
import type { DiffEntry, DiffResponse } from "@/api/client";
import { buildNodeDiffDetail, buildUnifiedGraph, summarizeDiff } from "@/lib/diffHelpers";

const diff = (entries: DiffEntry[], renames?: DiffResponse["renames"]): DiffResponse => ({
  from_version: 1,
  to_version: 2,
  entries,
  summary: "",
  renames,
});

const irNode = (name: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: name.toLowerCase(),
  name,
  node_type: "gmail.send_message",
  position: { x, y },
  parameters: {},
  ...extra,
});

const irDoc = (nodes: unknown[], edges: Array<[string, string]> = []) => ({
  nodes,
  edges: edges.map(([s, t]) => ({ id: `e-${s}-${t}`, source_node_id: s, target_node_id: t })),
});

describe("edge identity", () => {
  // A concatenated key would make "A"→"BC" and "AB"→"C" the same edge, and the diff would
  // silently report one unchanged wire instead of one removed and one added.
  it("cannot collide across a differently-split pair of node names", () => {
    const nodes = [irNode("A", 0, 0), irNode("BC", 200, 0), irNode("AB", 0, 200), irNode("C", 200, 200)];
    const base = irDoc(nodes, [["a", "bc"]]);
    const head = irDoc(nodes, [["ab", "c"]]);
    const graph = buildUnifiedGraph(base, head, diff([]));

    expect(graph.base.edges).toEqual([
      { source: "A", target: "BC", status: "removed", isGhost: false },
      { source: "AB", target: "C", status: "added", isGhost: true },
    ]);
  });

  it("is directional", () => {
    const nodes = [irNode("A", 0, 0), irNode("B", 200, 0)];
    const graph = buildUnifiedGraph(irDoc(nodes, [["a", "b"]]), irDoc(nodes, [["b", "a"]]), diff([]));
    expect(graph.head.edges.map((e) => [e.source, e.target, e.status])).toEqual([
      ["A", "B", "removed"],
      ["B", "A", "added"],
    ]);
  });
});

describe("summarizeDiff", () => {
  it("counts nodes and edges by operation", () => {
    const summary = summarizeDiff(
      diff([
        { operation: "add_node", target_id: "1", target_name: "New" },
        { operation: "remove_node", target_id: "2", target_name: "Gone" },
        { operation: "add_edge", target_id: "e1" },
        { operation: "add_edge", target_id: "e2" },
        { operation: "remove_edge", target_id: "e3" },
      ]),
    );
    expect(summary).toEqual({ added: 1, removed: 1, modified: 0, edgeAdded: 2, edgeRemoved: 1 });
  });

  it("counts a node modified ONCE however many fields changed on it", () => {
    const summary = summarizeDiff(
      diff([
        { operation: "modify_node", target_id: "1", target_name: "Send", path: "parameters.to" },
        { operation: "modify_node", target_id: "1", target_name: "Send", path: "parameters.subject" },
        { operation: "rename_node", target_id: "1", target_name: "Send", old_value: "S", new_value: "Send" },
      ]),
    );
    expect(summary.modified).toBe(1);
  });

  it("returns zeroes for an empty diff", () => {
    expect(summarizeDiff(diff([]))).toEqual({ added: 0, removed: 0, modified: 0, edgeAdded: 0, edgeRemoved: 0 });
  });
});

describe("buildNodeDiffDetail", () => {
  it("returns null when the node has no entries", () => {
    expect(buildNodeDiffDetail(diff([]), "Send")).toBeNull();
  });

  it("classifies each change by section", () => {
    const detail = buildNodeDiffDetail(
      diff([
        { operation: "modify_node", target_id: "1", target_name: "Send", path: "parameters.to", new_value: "b" },
        { operation: "modify_node", target_id: "1", target_name: "Send", path: "credentials.slack", old_value: "x" },
        { operation: "modify_node", target_id: "1", target_name: "Send", path: "node_type", old_value: "a", new_value: "b" },
      ]),
      "Send",
    );
    expect(detail?.changes.map((c) => [c.section, c.kind])).toEqual([
      ["parameters", "added"],
      ["credentials", "removed"],
      ["type", "modified"],
    ]);
  });

  it("reports a move as a delta rather than raw coordinates", () => {
    const detail = buildNodeDiffDetail(
      diff([
        {
          operation: "modify_node",
          target_id: "1",
          target_name: "Send",
          path: "position",
          old_value: { x: 10, y: 20 },
          new_value: { x: 40, y: 15 },
        },
      ]),
      "Send",
    );
    expect(detail?.positionDelta).toEqual({ dx: 30, dy: -5 });
    // A pure move is not a content change, so the summary status stays unchanged.
    expect(detail?.status).toBe("unchanged");
  });

  it("resolves a BASE-canvas click on the OLD name through the renames map", () => {
    const entries: DiffEntry[] = [
      { operation: "rename_node", target_id: "1", target_name: "Send email", old_value: "Send", new_value: "Send email" },
    ];
    const renames = [{ old_name: "Send", new_name: "Send email" }];
    const fromBase = buildNodeDiffDetail(diff(entries, renames), "Send");
    expect(fromBase).toMatchObject({ key: "Send", name: "Send email", oldName: "Send", status: "modified" });
  });

  it("keeps add/remove status ahead of a co-reported modification", () => {
    const added = buildNodeDiffDetail(
      diff([
        { operation: "add_node", target_id: "1", target_name: "New" },
        { operation: "modify_node", target_id: "1", target_name: "New", path: "parameters.to", new_value: "x" },
      ]),
      "New",
    );
    expect(added?.status).toBe("added");
  });

  it("ignores non-node operations under the same key", () => {
    const detail = buildNodeDiffDetail(
      diff([
        { operation: "add_edge", target_id: "Send" },
        { operation: "modify_node", target_id: "1", target_name: "Send", path: "parameters.to", new_value: "x" },
      ]),
      "Send",
    );
    expect(detail?.changes).toHaveLength(1);
  });
});

describe("buildUnifiedGraph", () => {
  it("marks each side's exclusives and ghosts them onto the other canvas", () => {
    const base = irDoc([irNode("A", 0, 0), irNode("B", 200, 0)], [["a", "b"]]);
    const head = irDoc([irNode("A", 0, 0), irNode("B", 200, 0), irNode("C", 600, 0)], [["a", "b"], ["b", "c"]]);
    const graph = buildUnifiedGraph(base, head, diff([{ operation: "add_node", target_id: "c", target_name: "C" }]));

    expect(graph.head.nodes.find((n) => n.name === "C")).toMatchObject({ status: "added", isGhost: false });
    expect(graph.base.nodes.find((n) => n.name === "C")).toMatchObject({ status: "added", isGhost: true });
    expect(graph.base.edges.find((e) => e.target === "C")).toMatchObject({ status: "added", isGhost: true });
    expect(graph.head.edges.find((e) => e.target === "C")).toMatchObject({ status: "added", isGhost: false });
  });

  it("suppresses a ghost that would land on top of a real node", () => {
    const base = irDoc([irNode("Old", 300, 300)]);
    const head = irDoc([irNode("New", 320, 300)]);
    const graph = buildUnifiedGraph(base, head, diff([]));
    expect(graph.head.nodes.filter((n) => n.isGhost)).toEqual([]);
    expect(graph.base.nodes.filter((n) => n.isGhost)).toEqual([]);
  });

  it("renders a rename as one node modified on both sides, never as remove + add", () => {
    const base = irDoc([irNode("Send", 0, 0)]);
    const head = irDoc([{ ...irNode("Send email", 0, 0), id: "send" }]);
    const graph = buildUnifiedGraph(
      base,
      head,
      diff(
        [{ operation: "rename_node", target_id: "send", target_name: "Send email", old_value: "Send", new_value: "Send email" }],
        [{ old_name: "Send", new_name: "Send email" }],
      ),
    );
    expect(graph.base.nodes).toEqual([expect.objectContaining({ name: "Send", status: "modified-old", isGhost: false })]);
    expect(graph.head.nodes).toEqual([
      expect.objectContaining({ name: "Send email", status: "modified-new", isGhost: false }),
    ]);
  });

  it("matches a renamed node's edges across sides instead of reading them as removed + added", () => {
    const base = irDoc([irNode("A", 0, 0), irNode("Send", 200, 0)], [["a", "send"]]);
    const head = irDoc([irNode("A", 0, 0), { ...irNode("Send email", 200, 0), id: "send" }], [["a", "send"]]);
    const graph = buildUnifiedGraph(
      base,
      head,
      diff(
        [{ operation: "rename_node", target_id: "send", target_name: "Send email", old_value: "Send", new_value: "Send email" }],
        [{ old_name: "Send", new_name: "Send email" }],
      ),
    );
    expect(graph.base.edges).toEqual([{ source: "A", target: "Send", status: "unchanged", isGhost: false }]);
    expect(graph.head.edges).toEqual([{ source: "A", target: "Send email", status: "unchanged", isGhost: false }]);
  });

  it("leaves a position-only change unchanged — the offset already shows it", () => {
    const base = irDoc([irNode("A", 0, 0)]);
    const head = irDoc([irNode("A", 400, 0)]);
    const graph = buildUnifiedGraph(
      base,
      head,
      diff([
        {
          operation: "modify_node",
          target_id: "a",
          target_name: "A",
          path: "position",
          old_value: { x: 0, y: 0 },
          new_value: { x: 400, y: 0 },
        },
      ]),
    );
    expect(graph.base.nodes[0].status).toBe("unchanged");
    expect(graph.head.nodes[0].status).toBe("unchanged");
  });

  it("reads the legacy {nodes, connections} graph as well as IR", () => {
    const legacy = {
      nodes: [
        { name: "A", type: "gmail.send_message", position: [0, 0], parameters: {} },
        { name: "B", type: "gmail.send_message", position: [200, 0], parameters: {} },
      ],
      connections: { A: { main: [[{ node: "B" }]] } },
    };
    const graph = buildUnifiedGraph(legacy, legacy, diff([]));
    expect(graph.base.nodes.map((n) => [n.name, n.position])).toEqual([
      ["A", { x: 0, y: 0 }],
      ["B", { x: 200, y: 0 }],
    ]);
    expect(graph.base.edges).toEqual([{ source: "A", target: "B", status: "unchanged", isGhost: false }]);
  });

  it("survives an absent side and a null diff", () => {
    const graph = buildUnifiedGraph(undefined, undefined, null);
    expect(graph).toEqual({ base: { nodes: [], edges: [] }, head: { nodes: [], edges: [] } });
  });

  it("gives a nameless node the same fallback key in nodes and edges", () => {
    const doc = {
      nodes: [{ id: "n0", node_type: "gmail.send_message", position: { x: 0, y: 0 } }, irNode("B", 200, 0)],
      edges: [{ id: "e", source_node_id: "n0", target_node_id: "b" }],
    };
    const graph = buildUnifiedGraph(doc, doc, diff([]));
    expect(graph.base.edges).toEqual([{ source: "Node 0", target: "B", status: "unchanged", isGhost: false }]);
  });
});
