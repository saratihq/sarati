import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findTriggerNode, isManualTrigger, triggerKindLabel } from "@/lib/triggerKind";

/**
 * VAULT MIRROR — "how does this workflow start?" is the server constitution's question (,
 * `compiler/compile-ir.ts` isTriggerNode). `@/lib/triggerKind` is the client's ONE answer, and a
 * second competing copy lives in `IrNodeInspector.tsx`. This spec pins the answer AND cross-checks
 * every copy against it, so the two can never quietly disagree about what a node_type means.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITION_SITE = "lib/triggerKind.ts";

/** Files known to carry a second copy. A copy may be DELETED freely; a NEW one must not appear. */
const KNOWN_MIRRORS = ["components/IrNodeInspector.tsx"];

/** THE table. Every copy of the answer, wherever it lives, must agree with this. */
const TRIGGER_KINDS = [
  { nodeType: undefined, kind: "manual", label: "Manual start" },
  { nodeType: "", kind: "manual", label: "Manual start" },
  { nodeType: "orchestr:trigger", kind: "manual", label: "Manual start" },
  { nodeType: "orchestr:webhook", kind: "webhook", label: "Webhook" },
  { nodeType: "orchestr:schedule", kind: "schedule", label: "Schedule" },
  { nodeType: "orchestr:chat", kind: "chat", label: "Chat" },
  // An app trigger is "<app>.<event>" — the DOT is what makes it one, not any prefix.
  { nodeType: "gmail.new_email", kind: "app", label: "New email" },
  { nodeType: "rss.new-item", kind: "app", label: "New item" },
  { nodeType: "stripe.charge_succeeded", kind: "app", label: "Charge succeeded" },
  // A dot-less type nothing recognises falls back to the manual start on BOTH sides.
  { nodeType: "orchestr:agent", kind: "manual", label: "Manual start" },
] as const;

describe("triggerKind: the client's one answer", () => {
  it.each(TRIGGER_KINDS)("labels $nodeType as $label", ({ nodeType, label }) => {
    expect(triggerKindLabel(nodeType)).toBe(label);
  });

  it.each([undefined, "", "orchestr:trigger"])("treats %s as the on-demand manual start", (nodeType) => {
    expect(isManualTrigger(nodeType)).toBe(true);
  });

  it.each(["orchestr:webhook", "orchestr:schedule", "orchestr:chat", "gmail.new_email"])(
    "treats %s as a trigger that fires on its own",
    (nodeType) => {
      expect(isManualTrigger(nodeType)).toBe(false);
    },
  );
});

describe("triggerKind: finding the trigger node in a document", () => {
  it("finds the node whose id is the reserved 'trigger'", () => {
    const trigger = { id: "trigger", node_type: "anything" };
    expect(findTriggerNode([{ id: "a" }, trigger])).toBe(trigger);
  });

  it.each(["orchestr:trigger", "orchestr:webhook", "orchestr:schedule", "orchestr:chat"])(
    "finds a node typed %s",
    (node_type) => {
      const trigger = { id: "n1", node_type };
      expect(findTriggerNode([{ id: "a", node_type: "slack.post" }, trigger])).toBe(trigger);
    },
  );

  it("finds an app trigger by its metadata marker — its type carries no keyword", () => {
    const trigger = { id: "n1", node_type: "gmail.new_email", metadata: { trigger: true } };
    expect(findTriggerNode([trigger])).toBe(trigger);
  });

  it("ignores a falsy metadata marker", () => {
    const nodes = [{ id: "n1", node_type: "gmail.new_email", metadata: { trigger: false } }];
    expect(findTriggerNode(nodes)).toBeNull();
  });

  it("returns the FIRST match in document order", () => {
    const first = { id: "n1", node_type: "orchestr:webhook" };
    const second = { id: "n2", node_type: "orchestr:schedule" };
    expect(findTriggerNode([first, second])).toBe(first);
  });

  it("returns null for a triggerless document", () => {
    expect(findTriggerNode([{ id: "a", node_type: "slack.post" }])).toBeNull();
  });

  it.each([null, undefined, "not an array", 42, {}])("returns null rather than throwing on %s", (nodes) => {
    expect(findTriggerNode(nodes as Parameters<typeof findTriggerNode>[0])).toBeNull();
  });
});

// ─── Mirror-drift guard ───

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFilesUnder(path, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

/** A file re-answers the question when one of its functions returns three or more distinct kinds. */
function classifierIn(source: string): { params: string; body: string } | null {
  for (const fn of source.matchAll(/function\s+\w+\s*\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/g)) {
    const kinds = new Set([...fn[2].matchAll(/return\s*"(manual|webhook|schedule|chat|app)"/g)].map((m) => m[1]));
    if (kinds.size >= 3) return { params: fn[1], body: fn[2] };
  }
  return null;
}

/** Compile the copy in place — string constants and all — so it can be run against the same table. */
function compile(source: string, classifier: { params: string; body: string }): (t?: string) => string {
  const constants = [...source.matchAll(/^const\s+(\w+)\s*=\s*("[^"]*");$/gm)]
    .map(([, name, value]) => `const ${name} = ${value};`)
    .join("\n");
  const params = classifier.params.replace(/\??\s*:\s*[^,]+/g, "");
  return new Function(`${constants}\nreturn function (${params}) {${classifier.body}\n};`)() as (
    t?: string,
  ) => string;
}

describe("vault mirror: every copy of the trigger-kind answer agrees", () => {
  const files = tsFilesUnder(SRC)
    .map((path) => ({ rel: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }))
    .filter((f) => f.rel !== DEFINITION_SITE);

  it("no NEW competing copy has appeared", () => {
    const unexpected = files
      .filter((f) => classifierIn(f.text) !== null)
      .map((f) => f.rel)
      .filter((rel) => !KNOWN_MIRRORS.includes(rel));

    // Import from `@/lib/triggerKind` instead of adding a row here.
    expect(unexpected).toEqual([]);
  });

  it.each(KNOWN_MIRRORS)("%s answers exactly as @/lib/triggerKind", (rel) => {
    const file = files.find((f) => f.rel === rel);
    if (!file) return; // the copy was deleted — the outcome this guard wants.
    const classifier = classifierIn(file.text);
    if (!classifier) return; // the copy now delegates — nothing left to drift.

    const mirrored = compile(file.text, classifier);
    for (const { nodeType, kind } of TRIGGER_KINDS) {
      expect(mirrored(nodeType), `${rel} disagrees about "${nodeType}"`).toBe(kind);
    }
  });
});
