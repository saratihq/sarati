import { describe, expect, it } from "vitest";
import type { NodeParamSchema } from "@/api/client";
import {
  DIFF_COLORS,
  defaultParamsFromSchema,
  getNodeCategory,
  getNodeColor,
  getNodeTypeLabel,
  hasTwoOutputPorts,
  isNativeOrTriggerType,
  opDropsRight,
  opLabel,
  outputPortCount,
} from "@/lib/constants";

describe("getNodeCategory: EXACT type matching", () => {
  it.each([
    "orchestr:trigger",
    "orchestr:schedule",
    "orchestr:chat",
    "orchestr:webhook",
    "orchestr:webhook_trigger",
  ])("classifies %s as a trigger", (type) => {
    expect(getNodeCategory(type)).toBe("trigger");
  });

  it.each(["orchestr:if", "orchestr:switch", "orchestr:loop"])("classifies %s as logic", (type) => {
    expect(getNodeCategory(type)).toBe("logic");
  });

  it("classifies the code node as a transform", () => {
    expect(getNodeCategory("orchestr:code")).toBe("transform");
  });

  it("classifies the AI agent as an action, never as a trigger or a router", () => {
    expect(getNodeCategory("orchestr:agent")).toBe("action");
  });

  /**
   * The whole point of the exact match: plenty of ordinary app actions CONTAIN a control word
   * ("notify" contains "if", "workflow.loop_items" contains "loop"). A substring rule would route
   * them through the canvas's logic-node guard and break the connect op.
   */
  it.each(["notify.send_alert", "spotify.play_track", "workflow.loop_items", "github.code_search"])(
    "classifies %s as a plain action despite containing a control word",
    (type) => {
      expect(getNodeCategory(type)).toBe("action");
    },
  );

  it("does not treat a near-miss orchestr type as its control node", () => {
    expect(getNodeCategory("orchestr:code_review")).toBe("action");
    expect(getNodeCategory("orchestr:loop_helper")).toBe("action");
  });
});

describe("isNativeOrTriggerType: whose null catalog lookup is expected", () => {
  it.each([undefined, "orchestr:if", "orchestr:agent", "gmail.new_email_trigger", "gmail.new_email_TRIGGER"])(
    "spares %s",
    (type) => {
      expect(isNativeOrTriggerType(type)).toBe(true);
    },
  );

  it("spares an app trigger by its metadata marker", () => {
    expect(isNativeOrTriggerType("gmail.new_email", { trigger: true })).toBe(true);
  });

  it.each([
    { label: "no metadata", metadata: undefined },
    { label: "null metadata", metadata: null },
    { label: "a non-boolean marker", metadata: { trigger: "yes" } },
  ])("flags an ordinary action with $label", ({ metadata }) => {
    expect(isNativeOrTriggerType("gmail.send_message", metadata)).toBe(false);
  });
});

describe("outputPortCount", () => {
  it("gives a switch one port per case plus the default", () => {
    expect(outputPortCount("orchestr:switch", { cases: [{}, {}, {}] })).toBe(4);
    expect(outputPortCount("orchestr:switch", { cases: [] })).toBe(1);
  });

  it.each([
    { label: "no parameters", params: undefined },
    { label: "no cases key", params: {} },
    { label: "a malformed cases value", params: { cases: "nope" } },
  ])("never renders a switch port-less with $label", ({ params }) => {
    expect(outputPortCount("orchestr:switch", params)).toBe(1);
  });

  it.each(["orchestr:if", "orchestr:loop"])("gives %s two ports", (type) => {
    expect(hasTwoOutputPorts(type)).toBe(true);
    expect(outputPortCount(type)).toBe(2);
  });

  it("gives an ordinary action one port", () => {
    expect(hasTwoOutputPorts("gmail.send_message")).toBe(false);
    expect(outputPortCount("gmail.send_message")).toBe(1);
  });
});

describe("getNodeTypeLabel", () => {
  it.each([
    { type: "gmail.send_message", label: "Send message" },
    { type: "slack.postMessage", label: "Post Message" },
    { type: "rss.new-item", label: "New item" },
    { type: "orchestr:agent", label: "AI Agent" },
    { type: "orchestr:wait_for_event", label: "Wait for event" },
    { type: "orchestr:if", label: "If" },
    { type: "custom", label: "Custom" },
  ])("labels $type as $label", ({ type, label }) => {
    expect(getNodeTypeLabel(type)).toBe(label);
  });
});

describe("condition operators", () => {
  it.each(["truthy", "falsy"])("drops the right operand for the unary op %s", (op) => {
    expect(opDropsRight(op)).toBe(true);
  });

  it.each(["eq", "ne", "gt", "gte", "lt", "lte", "contains"])("keeps the right operand for %s", (op) => {
    expect(opDropsRight(op)).toBe(false);
  });

  it("reads each known op in plain language", () => {
    expect(opLabel("gte")).toBe("is greater than or equal to");
    expect(opLabel("contains")).toBe("contains");
  });

  it("falls back to the raw op code rather than rendering nothing", () => {
    expect(opLabel("regex_match")).toBe("regex_match");
  });
});

describe("defaultParamsFromSchema", () => {
  const schema = (spec: Partial<NodeParamSchema>): Record<string, NodeParamSchema> => ({
    field: { type: "STRING", ...spec },
  });

  it("seeds a catalog default", () => {
    expect(defaultParamsFromSchema(schema({ default: "hello" }))).toEqual({ field: "hello" });
  });

  it("prefers the alternate defaultValue key the catalog sometimes emits", () => {
    expect(defaultParamsFromSchema(schema({ defaultValue: "alt", default: "main" }))).toEqual({ field: "alt" });
  });

  it("keeps a falsy default — false and 0 are real values", () => {
    expect(defaultParamsFromSchema(schema({ default: false }))).toEqual({ field: false });
    expect(defaultParamsFromSchema(schema({ default: 0 }))).toEqual({ field: 0 });
  });

  it("treats a null defaultValue as absent and falls through", () => {
    expect(defaultParamsFromSchema(schema({ defaultValue: null, default: "main" }))).toEqual({ field: "main" });
  });

  it("omits a param with no default at all", () => {
    expect(defaultParamsFromSchema(schema({}))).toEqual({});
  });

  it("handles an absent schema", () => {
    expect(defaultParamsFromSchema(undefined)).toEqual({});
  });
});

describe("the persisted CSS variable names", () => {
  it("colors nodes from the theme token, not a per-type table", () => {
    expect(getNodeColor("gmail.send_message")).toBe("var(--orchestr-ink-muted)");
    expect(getNodeColor("orchestr:if")).toBe(getNodeColor("gmail.send_message"));
  });

  it("keeps the diff palette on --orchestr-* tokens", () => {
    expect(Object.keys(DIFF_COLORS).sort()).toEqual([
      "accent",
      "added",
      "modifiedNew",
      "modifiedOld",
      "neutral",
      "removed",
    ]);
    expect(DIFF_COLORS.added).toBe("var(--orchestr-success)");
    expect(DIFF_COLORS.removed).toBe("var(--orchestr-danger)");
  });
});
