import { describe, expect, it } from "vitest";
import { irCanvasKey, irContentKey } from "@/lib/irCompare";

/**
 * VAULT #4 — the client's ONE answer to "did the content change?". Byte-comparing documents is
 * banned (and lint-enforced) because key order is not content: that is how phantom "Unsaved
 * changes" banners and phantom merge conflicts were born.
 */

const doc = (nodes: unknown[], edges: unknown[] = []) => ({ nodes, edges });

describe("irContentKey: content identity", () => {
  it("ignores key order at every depth", () => {
    const a = { nodes: [{ id: "n1", node_type: "gmail.send", parameters: { to: "a", subject: "b" } }], edges: [] };
    const b = { edges: [], nodes: [{ parameters: { subject: "b", to: "a" }, node_type: "gmail.send", id: "n1" }] };
    expect(irContentKey(a)).toBe(irContentKey(b));
    // …and the byte comparison this replaces would have disagreed.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("ignores node coordinates — a pure move is not a content change", () => {
    const before = doc([{ id: "n1", position: { x: 0, y: 0 } }]);
    const after = doc([{ id: "n1", position: { x: 900, y: 40 } }]);
    expect(irContentKey(before)).toBe(irContentKey(after));
  });

  it("ignores a nested position too", () => {
    const before = doc([{ id: "n1", metadata: { hint: { position: { x: 1, y: 1 } } } }]);
    const after = doc([{ id: "n1", metadata: { hint: { position: { x: 2, y: 2 } } } }]);
    expect(irContentKey(before)).toBe(irContentKey(after));
  });

  it.each([
    { label: "a changed parameter", after: doc([{ id: "n1", parameters: { to: "b" } }]) },
    { label: "a renamed node", after: doc([{ id: "n1", name: "Renamed", parameters: { to: "a" } }]) },
    { label: "an added node", after: doc([{ id: "n1", parameters: { to: "a" } }, { id: "n2" }]) },
    { label: "an added edge", after: doc([{ id: "n1", parameters: { to: "a" } }], [{ id: "e1" }]) },
  ])("sees $label", ({ after }) => {
    expect(irContentKey(doc([{ id: "n1", parameters: { to: "a" } }]))).not.toBe(irContentKey(after));
  });

  it("keeps array ORDER significant — reordered steps are a different document", () => {
    expect(irContentKey(doc([{ id: "a" }, { id: "b" }]))).not.toBe(irContentKey(doc([{ id: "b" }, { id: "a" }])));
  });

  it("distinguishes an absent key from an explicitly null one", () => {
    expect(irContentKey(doc([{ id: "n1" }]))).not.toBe(irContentKey(doc([{ id: "n1", name: null }])));
  });

  it.each([null, undefined, 0, "", false, []])("handles the non-document value %s", (value) => {
    expect(() => irContentKey(value)).not.toThrow();
  });
});

describe("irCanvasKey: content PLUS layout", () => {
  it("sees a pure node move, which irContentKey deliberately does not", () => {
    const before = doc([{ id: "n1", position: { x: 0, y: 0 } }]);
    const after = doc([{ id: "n1", position: { x: 900, y: 40 } }]);
    expect(irCanvasKey(before)).not.toBe(irCanvasKey(after));
    expect(irContentKey(before)).toBe(irContentKey(after));
  });

  it("still ignores key order — layout is content here, serialization order never is", () => {
    const a = doc([{ id: "n1", position: { x: 1, y: 2 }, name: "A" }]);
    const b = doc([{ name: "A", position: { y: 2, x: 1 }, id: "n1" }]);
    expect(irCanvasKey(a)).toBe(irCanvasKey(b));
  });

  it("agrees with irContentKey whenever nothing carries a position", () => {
    const plain = doc([{ id: "n1", parameters: { to: "a" } }]);
    expect(irCanvasKey(plain)).toBe(irContentKey(plain));
  });
});
