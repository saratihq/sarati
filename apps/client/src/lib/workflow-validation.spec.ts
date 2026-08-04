import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeParamSchema, NodeTypeEntry } from "@/api/client";
import { collectMissingRequired } from "@/lib/workflow-validation";

// The catalog is fetched over HTTP by the panel module; the gate only needs its schema lookup.
// Hoisted alongside the mock, which vitest lifts above every import.
const { catalog } = vi.hoisted(() => ({ catalog: new Map<string, NodeTypeEntry>() }));
vi.mock("@/components/NodeCatalogPanel", () => ({
  catalogEntryFor: (nodeType: string) => Promise.resolve(catalog.get(nodeType) ?? null),
}));

function publish(type: string, parameters: Record<string, NodeParamSchema>) {
  catalog.set(type, {
    name: type,
    type,
    category: type.split(".")[0],
    description: "",
    auth: "none",
    parameters,
  });
}

const ir = (...nodes: Record<string, unknown>[]) => ({ nodes, edges: [] });
const node = (over: Record<string, unknown>) => ({ id: "n1", name: "Step", parameters: {}, ...over });

/** The raw param keys the gate flagged, in report order. */
const fieldsOf = async (doc: Record<string, unknown> | null) =>
  (await collectMissingRequired(doc)).map((m) => m.field);

beforeEach(() => {
  catalog.clear();
  publish("gmail.send_message", {
    to: { type: "STRING", required: true },
    subject: { type: "STRING", required: true },
    body: { type: "STRING", required: false },
    tips: { type: "MARKDOWN", required: true },
  });
});

describe("the flat required-field walk", () => {
  it("flags every empty required input", async () => {
    expect(await fieldsOf(ir(node({ node_type: "gmail.send_message" })))).toEqual(["to", "subject"]);
  });

  it("passes a fully configured step", async () => {
    const doc = ir(node({ node_type: "gmail.send_message", parameters: { to: "a@b.c", subject: "Hi" } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });

  it("never demands a MARKDOWN param — those are instructions, not inputs", async () => {
    const doc = ir(node({ node_type: "gmail.send_message", parameters: { to: "a", subject: "b" } }));
    expect(await fieldsOf(doc)).not.toContain("tips");
  });

  it.each([
    { label: "an empty string", value: "" },
    { label: "an empty array", value: [] },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ])("counts $label as missing", async ({ value }) => {
    const doc = ir(node({ node_type: "gmail.send_message", parameters: { to: value, subject: "b" } }));
    expect(await fieldsOf(doc)).toEqual(["to"]);
  });

  it.each([
    { label: "false", value: false },
    { label: "zero", value: 0 },
    { label: "an empty object", value: {} },
  ])("accepts $label — a run can use it", async ({ value }) => {
    const doc = ir(node({ node_type: "gmail.send_message", parameters: { to: value, subject: "b" } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });

  it("names the node in each report so the banner can point at it", async () => {
    const missing = await collectMissingRequired(ir(node({ id: "n7", name: "Email Bob", node_type: "gmail.send_message" })));
    expect(missing[0]).toMatchObject({ nodeId: "n7", nodeName: "Email Bob" });
  });

  it("falls back to the type when a node carries no name", async () => {
    const missing = await collectMissingRequired(ir(node({ name: "", node_type: "gmail.send_message" })));
    expect(missing[0].nodeName).toBe("gmail.send_message");
  });
});

describe("nodes the gate never demands inputs from", () => {
  it.each(["orchestr:trigger", "orchestr:trigger_manual", "orchestr:chat"])("skips %s", async (node_type) => {
    expect(await fieldsOf(ir(node({ node_type })))).toEqual([]);
  });

  it("skips a node with no type at all", async () => {
    expect(await fieldsOf(ir(node({})))).toEqual([]);
  });

  it.each([null, {}, { nodes: null }, { nodes: "nope" }])("reads %s as an empty document", async (doc) => {
    expect(await fieldsOf(doc as Record<string, unknown> | null)).toEqual([]);
  });
});

describe("a step whose action is no longer in the catalog", () => {
  it("is reported as a phantom that cannot run", async () => {
    const missing = await collectMissingRequired(ir(node({ node_type: "gmail.deleted_action" })));
    expect(missing).toEqual([
      expect.objectContaining({ field: "node_type", message: expect.stringContaining("unrecognized type") }),
    ]);
  });

  it("spares a native control node, whose null lookup is expected", async () => {
    expect(await fieldsOf(ir(node({ node_type: "orchestr:code" })))).toEqual([]);
  });

  it("spares an app trigger carrying the metadata marker", async () => {
    const doc = ir(node({ node_type: "gmail.new_email", metadata: { trigger: true } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });
});

describe("orchestr:loop", () => {
  it("requires the items collection in the default (items) mode", async () => {
    expect(await fieldsOf(ir(node({ node_type: "orchestr:loop" })))).toEqual(["items"]);
    expect(await fieldsOf(ir(node({ node_type: "orchestr:loop", parameters: { items: "{{a.rows}}" } })))).toEqual([]);
  });

  it("requires a condition AND an iteration cap in while mode", async () => {
    const doc = ir(node({ node_type: "orchestr:loop", parameters: { mode: "while" } }));
    expect(await fieldsOf(doc)).toEqual(["condition", "max_iterations"]);
  });

  it.each([
    { label: "missing", cap: undefined },
    { label: "zero", cap: 0 },
    { label: "negative", cap: -1 },
    { label: "fractional", cap: 2.5 },
    { label: "a string", cap: "10" },
  ])("refuses a $label iteration cap — the infinite-loop guard", async ({ cap }) => {
    const doc = ir(node({ node_type: "orchestr:loop", parameters: { mode: "while", condition: { left: "{{x}}" }, max_iterations: cap } }));
    expect(await fieldsOf(doc)).toEqual(["max_iterations"]);
  });

  it("accepts a complete while loop", async () => {
    const doc = ir(node({ node_type: "orchestr:loop", parameters: { mode: "while", condition: { left: "{{x}}" }, max_iterations: 5 } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });
});

describe("orchestr:switch", () => {
  it("needs at least one case to route on", async () => {
    expect(await fieldsOf(ir(node({ node_type: "orchestr:switch" })))).toEqual(["cases"]);
    expect(await fieldsOf(ir(node({ node_type: "orchestr:switch", parameters: { cases: [] } })))).toEqual(["cases"]);
  });

  it("checks each case for a value, an operator and a comparand", async () => {
    const doc = ir(node({ node_type: "orchestr:switch", parameters: { cases: [{}] } }));
    expect(await fieldsOf(doc)).toEqual(["cases.0.left", "cases.0.op"]);
  });

  it("requires the right operand only for a BINARY operator", async () => {
    const binary = ir(node({ node_type: "orchestr:switch", parameters: { cases: [{ left: "{{a}}", op: "eq" }] } }));
    expect(await fieldsOf(binary)).toEqual(["cases.0.right"]);

    const unary = ir(node({ node_type: "orchestr:switch", parameters: { cases: [{ left: "{{a}}", op: "truthy" }] } }));
    expect(await fieldsOf(unary)).toEqual([]);
  });

  it("reports the case number a human can find on screen", async () => {
    const doc = ir(node({ node_type: "orchestr:switch", parameters: { cases: [{ left: "{{a}}", op: "eq", right: 1 }, {}] } }));
    const missing = await collectMissingRequired(doc);
    expect(missing[0].message).toContain("case 2");
  });

  it("survives a malformed case entry", async () => {
    const doc = ir(node({ node_type: "orchestr:switch", parameters: { cases: [null, "nope"] } }));
    expect(await fieldsOf(doc)).toEqual(["cases.0.left", "cases.0.op", "cases.1.left", "cases.1.op"]);
  });
});

describe("orchestr:if", () => {
  it("requires the comparand under the default operator", async () => {
    expect(await fieldsOf(ir(node({ node_type: "orchestr:if", parameters: { left: "{{a}}" } })))).toEqual(["right"]);
  });

  it("drops the comparand for a unary operator", async () => {
    const doc = ir(node({ node_type: "orchestr:if", parameters: { left: "{{a}}", op: "falsy" } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });
});

describe("orchestr:schedule", () => {
  it("refuses an interval and a cron together — the engine rejects the pair", async () => {
    const doc = ir(node({ node_type: "orchestr:schedule", parameters: { cron: "* * * * *", interval_minutes: 5 } }));
    const missing = await collectMissingRequired(doc);
    expect(missing.map((m) => m.field)).toEqual(["cron"]);
    expect(missing[0].message).toContain("not both");
  });

  it.each([
    { label: "four fields", cron: "* * * *" },
    { label: "six fields", cron: "* * * * * *" },
    { label: "blank", cron: "   " },
  ])("refuses a $label cron", async ({ cron }) => {
    expect(await fieldsOf(ir(node({ node_type: "orchestr:schedule", parameters: { cron } })))).toEqual(["cron"]);
  });

  it("accepts a five-field cron", async () => {
    const doc = ir(node({ node_type: "orchestr:schedule", parameters: { cron: "*/15 9-17 * * 1-5" } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });

  it.each([
    { label: "no schedule at all", params: {} },
    { label: "zero minutes", params: { interval_minutes: 0 } },
    { label: "a fractional interval", params: { interval_minutes: 1.5 } },
    { label: "over a year", params: { interval_minutes: 525_601 } },
    { label: "a string interval", params: { interval_minutes: "30" } },
  ])("refuses $label", async ({ params }) => {
    expect(await fieldsOf(ir(node({ node_type: "orchestr:schedule", parameters: params })))).toEqual([
      "interval_minutes",
    ]);
  });

  it.each([1, 30, 525_600])("accepts an interval of %s minutes", async (interval_minutes) => {
    const doc = ir(node({ node_type: "orchestr:schedule", parameters: { interval_minutes } }));
    expect(await fieldsOf(doc)).toEqual([]);
  });
});

describe("the shape check and the flat walk together", () => {
  it("reports a shape-owned field ONCE, not twice", async () => {
    publish("orchestr:loop", { items: { type: "STRING", required: true } });
    const fields = await fieldsOf(ir(node({ node_type: "orchestr:loop" })));
    expect(fields).toEqual(["items"]);
  });

  it("still walks the catalog fields the shape check does not own", async () => {
    publish("orchestr:loop", {
      items: { type: "STRING", required: true },
      batch_size: { type: "NUMBER", required: true },
    });
    expect(await fieldsOf(ir(node({ node_type: "orchestr:loop" })))).toEqual(["items", "batch_size"]);
  });

  it("walks every node in the document", async () => {
    const doc = ir(
      node({ id: "a", node_type: "gmail.send_message", parameters: { to: "x", subject: "y" } }),
      node({ id: "b", node_type: "gmail.send_message" }),
      node({ id: "c", node_type: "orchestr:switch" }),
    );
    const missing = await collectMissingRequired(doc);
    expect(missing.map((m) => `${m.nodeId}.${m.field}`)).toEqual(["b.to", "b.subject", "c.cases"]);
  });
});
