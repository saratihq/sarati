"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertTriangle, Braces, Check, Clock, Copy, MessageCircle, Pin, Play, Plus, Search, Send, ShieldCheck, Sparkles, Trash2, Webhook, Workflow, Wrench, X, Zap } from "lucide-react";
import * as api from "@/api/client";
import type { AgentStep, CallableWorkflow, Connection, DropdownOption, NodeParamSchema, NodeTypeEntry, TriggerCatalogEntry } from "@/api/client";
import { apiBaseUrl } from "@/lib/config";
import { useWorkflow } from "@/store/useWorkflow";
import { useStepSamples } from "@/store/useStepSamples";
import { catalogEntryFor } from "./NodeCatalogPanel";
import NodeIcon from "./NodeIcon";
import SupportBadge from "./SupportBadge";
import { defaultParamsFromSchema, getNodeTypeLabel, isNativeOrTriggerType, opDropsRight, opLabel } from "@/lib/constants";
import { listEnvironments, type EnvironmentSlot } from "@/api/environments";
import { activeConnections, appDisplayName, candidateConnections, connectionLabel, matchingConnections } from "@/lib/connections";
import { humanizeKey } from "@/lib/format";
import { REAL_RUN_CONSEQUENCE, REAL_RUN_STEP_NOTE } from "@/lib/realRun";
import { toast } from "@/lib/toast";
import { useActiveConnections } from "@/lib/useConnections";
import { isEmpty as isFieldEmpty } from "@/lib/workflow-validation";
import ConnectAppButton from "./ConnectAppButton";
import { SaratiLoader } from "./SaratiLogo";
import { InlineError } from "./ui/inline-error";

const IF_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "truthy", "falsy"];

// Owned by LoopEditor (ADR 0029), so the generic field form never renders them raw.
const LOOP_PARAM_KEYS = new Set(["mode", "items", "item_var", "condition", "max_iterations"]);

// Owned by AgentEditor; these are the SERVICE compiler's keys (ADR 0045, compile-ir-dag
// buildAgentNode) — snake_case with `model` an object, and `memory` deliberately not a v1 param.
const AGENT_PARAM_KEYS = new Set(["system_prompt", "model", "max_steps", "input", "connectionId"]);

// Must stay in step with the `<provider>.generate_text` LLM nodes' models; `providerId` is the
// service compiler's provider enum value carried on the committed `model` object.
const AGENT_MODEL_GROUPS: ReadonlyArray<{ provider: string; providerId: string; models: string[] }> = [
  { provider: "Claude", providerId: "claude", models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"] },
  { provider: "OpenAI", providerId: "openai", models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"] },
  { provider: "Gemini", providerId: "gemini", models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"] },
  { provider: "Mistral", providerId: "mistral", models: ["mistral-large-latest", "mistral-small-latest", "open-mistral-nemo"] },
];
const DEFAULT_AGENT_MODEL = "claude-opus-4-8";
const DEFAULT_AGENT_PROVIDER = "claude";
const DEFAULT_AGENT_MAX_STEPS = 25;
// Must mirror the service compiler's MAX_AGENT_MAX_STEPS: over it is a deploy-time compile error.
const AGENT_MAX_STEPS_CEILING = 100;

// Display-only tolerant read of the `model` param; the committed shape must be `{ provider, model }`
// or compile-ir-dag throws (ADR 0045).
function agentModelParam(value: unknown): { provider?: string; model?: string } | undefined {
  if (typeof value === "string") return { model: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as { provider?: string; model?: string };
  }
  return undefined;
}

const FIELD_CLASS = "w-full h-8 px-2 rounded-lg text-[12px] outline-none";
const FIELD_STYLE = {
  background: "var(--orchestr-field)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
} as const;
const OPTION_STYLE = { background: "var(--orchestr-surface-card)" } as const;

// `ssr:false` is required: CodeMirror's modules touch the DOM at load, which breaks Next's prerender.
const CodeMirrorEditor = dynamic(() => import("./CodeMirrorEditor"), {
  ssr: false,
  loading: () => (
    <div
      className="w-full rounded-lg text-[11px] px-2 py-1.5 flex items-center"
      style={{
        minHeight: 140,
        background: "var(--orchestr-field)",
        border: "1px solid var(--orchestr-line)",
        color: "var(--orchestr-ink-subtle)",
      }}
    >
      Loading editor…
    </div>
  ),
});

// The Code node (orchestr:code) offers only js/ts for now; Python lands later.
const CODE_LANGUAGES: ReadonlyArray<{ value: "js" | "ts"; label: string }> = [
  { value: "js", label: "JavaScript" },
  { value: "ts", label: "TypeScript" },
];

// Stable identity so the samples selector doesn't churn renders when out of scope.
const EMPTY_SAMPLES: Record<string, unknown> = {};
// Last run-samples fetch per workflow — the inspector remounts per node click.
const runSamplesFetchedAt = new Map<string, number>();

// Catalog kinds carrying an enum; static ones inline their options, dynamic ones load live.
const DROPDOWN_KINDS = new Set([
  "DROPDOWN",
  "STATIC_DROPDOWN",
  "MULTI_SELECT_DROPDOWN",
  "STATIC_MULTI_SELECT_DROPDOWN",
  "DYNAMIC",
]);
const MULTI_KINDS = new Set(["MULTI_SELECT_DROPDOWN", "STATIC_MULTI_SELECT_DROPDOWN"]);
// Multi-line prop kinds, in both catalog dialects: the SDK's LONG_TEXT and the control nodes' longText.
const LONG_TEXT_KINDS = new Set(["LONG_TEXT", "LONGTEXT"]);

interface IrNodeShape {
  id: string;
  name?: string;
  node_type?: string;
  parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Claude accepts 0–1 where the others accept 0–2, so a value the provider would 400 on is caught here.
function temperatureMaxFor(providerSlug: string | undefined): number {
  return providerSlug === "claude" || providerSlug === "anthropic" ? 1 : 2;
}

/** Bounds for a NUMBER param: the catalog's own min/max/step first, else a per-field default. */
function numericBounds(
  key: string,
  spec: NodeParamSchema | undefined,
  providerSlug: string | undefined,
): { min?: number; max?: number; step?: number } {
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const min = num(spec?.min);
  const max = num(spec?.max);
  const step = num(spec?.step);
  if (min !== undefined || max !== undefined || step !== undefined) return { min, max, step };
  if (key.toLowerCase() === "temperature") {
    return { min: 0, max: temperatureMaxFor(providerSlug), step: 0.1 };
  }
  return {};
}

/** Normalise catalog options (`[{label,value}]` or bare scalars) to `{label,value}`. */
function toOptions(raw: readonly unknown[]): DropdownOption[] {
  const out: DropdownOption[] = [];
  for (const o of raw) {
    if (o !== null && typeof o === "object" && "value" in (o as Record<string, unknown>)) {
      const r = o as { label?: unknown; value: unknown };
      const label = typeof r.label === "string" && r.label ? r.label : String(r.value ?? "");
      out.push({ label, value: r.value });
    } else if (o !== null && o !== undefined) {
      out.push({ label: String(o), value: o });
    }
  }
  return out;
}

/**
 * Enum control (single or multi) that preserves each option's original value type; a current value
 * outside the list is kept as an extra option so an AI-authored value is never silently dropped.
 */
function SelectField({
  options,
  value,
  multiple,
  placeholder,
  onChange,
  ariaLabel,
}: {
  options: DropdownOption[];
  value: unknown;
  multiple: boolean;
  placeholder?: string;
  onChange: (value: unknown) => void;
  ariaLabel: string;
}) {
  const norm = options.map((o, i) => ({ key: String(i), label: o.label, value: o.value, sval: String(o.value) }));

  if (multiple) {
    const selected = Array.isArray(value) ? value.map((v) => String(v)) : [];
    return (
      <select
        multiple
        value={selected}
        aria-label={ariaLabel}
        onChange={(e) => {
          const picked = Array.from(e.target.selectedOptions).map((opt) => {
            const hit = norm.find((n) => n.sval === opt.value);
            return hit ? hit.value : opt.value;
          });
          onChange(picked);
        }}
        className="w-full px-2 py-1.5 rounded-lg text-[12px] outline-none"
        style={FIELD_STYLE}
      >
        {norm.map((n) => (
          <option key={n.key} value={n.sval} style={OPTION_STYLE}>
            {n.label}
          </option>
        ))}
      </select>
    );
  }

  const sval = value === null || value === undefined ? "" : String(value);
  const known = norm.some((n) => n.sval === sval);
  return (
    <select
      value={sval}
      aria-label={ariaLabel}
      onChange={(e) => {
        const hit = norm.find((n) => n.sval === e.target.value);
        onChange(hit ? hit.value : e.target.value);
      }}
      className={FIELD_CLASS}
      style={FIELD_STYLE}
    >
      {sval === "" && <option value="">{placeholder ?? "Select…"}</option>}
      {sval !== "" && !known && <option value={sval}>{sval}</option>}
      {norm.map((n) => (
        <option key={n.key} value={n.sval} style={OPTION_STYLE}>
          {n.label}
        </option>
      ))}
    </select>
  );
}

/**
 * JSON editor for ARRAY / OBJECT params: commits the PARSED value the moment it parses, so a
 * half-typed string never lands in the IR. Malformed input only warns — the server still decides.
 * Draft state is self-contained, so remount via a `key` including the node id.
 */
function JsonParamField({
  value,
  kind,
  items,
  onChange,
  ariaLabel,
  background = "var(--orchestr-field)",
  restBorder = "var(--orchestr-line)",
}: {
  value: unknown;
  kind: string;
  items?: { type?: string; enum?: unknown[] };
  onChange: (value: unknown) => void;
  ariaLabel: string;
  background?: string;
  restBorder?: string;
}) {
  // Shape is enforced only for an explicitly declared ARRAY/OBJECT, so a structured value under an
  // untyped param is never mis-flagged.
  const wantsArray = kind === "ARRAY";
  const wantsObject = kind === "OBJECT";
  const stored =
    value !== null && value !== undefined && typeof value === "object"
      ? JSON.stringify(value, null, 2)
      : typeof value === "string"
        ? value
        : wantsArray
          ? "[]"
          : "{}";
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? stored;

  const itemType = typeof items?.type === "string" ? items.type.toLowerCase() : undefined;
  const arrayExample = itemType === "number" || itemType === "integer" ? "[1, 2]" : '["a", "b"]';
  const hint = wantsArray
    ? `Enter a JSON array, e.g. ${arrayExample}`
    : wantsObject
      ? 'Enter a JSON object, e.g. {"key": "value"}'
      : "Enter valid JSON.";

  // A non-empty value must parse and, when the type is declared, match its shape.
  let malformed = false;
  const trimmed = text.trim();
  if (trimmed !== "") {
    try {
      const parsed = JSON.parse(trimmed);
      if (wantsArray) malformed = !Array.isArray(parsed);
      else if (wantsObject) malformed = parsed === null || typeof parsed !== "object" || Array.isArray(parsed);
    } catch {
      malformed = true;
    }
  }

  return (
    <>
      <textarea
        value={text}
        rows={4}
        aria-label={ariaLabel}
        placeholder={hint}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          try {
            onChange(JSON.parse(next));
          } catch {
            // Keep typing — the value commits to the IR once it parses.
          }
        }}
        className="w-full px-2 py-1.5 rounded-lg text-[11px] font-mono outline-none"
        style={{
          background,
          border: `1px solid ${malformed ? "var(--orchestr-warning)" : restBorder}`,
          color: "var(--orchestr-ink)",
        }}
        data-testid={`json-param-${ariaLabel}`}
      />
      {malformed && (
        <p
          className="text-[10px] m-0 mt-1 leading-snug"
          style={{ color: "var(--orchestr-warning)" }}
          data-testid={`json-param-hint-${ariaLabel}`}
        >
          {hint}
        </p>
      )}
    </>
  );
}

/**
 * Dropdown whose options load from `POST /node-types/:type/options`, refetching when the step's
 * connection changes. Any failure degrades to the plain text field so authoring is never blocked.
 */
function DynamicOptionsField({
  nodeType,
  prop,
  value,
  connectionId,
  multiple,
  onChange,
  ariaLabel,
  fallback,
  connectionHint,
}: {
  nodeType: string;
  prop: string;
  value: unknown;
  connectionId: string | undefined;
  multiple: boolean;
  onChange: (value: unknown) => void;
  ariaLabel: string;
  fallback: ReactNode;
  /** Hint for the no-connection degrade only; worded by the caller, since each surface differs. */
  connectionHint?: string;
}) {
  const [ready, setReady] = useState<{ options: DropdownOption[]; placeholder?: string } | null>(null);
  useEffect(() => {
    // Deliberately no synchronous reset: the `cancelled` guard drops stale responses instead.
    let cancelled = false;
    api
      .loadNodeTypeOptions(nodeType, { prop, ...(connectionId ? { connection_id: connectionId } : {}) })
      .then((res) => {
        if (cancelled) return;
        if (!res.disabled && Array.isArray(res.options) && res.options.length > 0) {
          setReady({ options: res.options, placeholder: res.placeholder });
        } else {
          setReady(null); // disabled/empty → keep the text fallback
        }
      })
      .catch(() => {
        if (!cancelled) setReady(null); // 404 / transient → text fallback
      });
    return () => {
      cancelled = true;
    };
  }, [nodeType, prop, connectionId]);

  if (!ready) {
    return (
      <>
        {fallback}
        {connectionHint && (
          <p
            className="text-[10px] m-0 mt-1 leading-snug"
            style={{ color: "var(--orchestr-ink-subtle)" }}
            data-testid={`dynamic-options-hint-${prop}`}
          >
            {connectionHint}
          </p>
        )}
      </>
    );
  }
  return (
    <SelectField
      options={ready.options}
      value={value}
      multiple={multiple}
      placeholder={ready.placeholder}
      onChange={onChange}
      ariaLabel={ariaLabel}
    />
  );
}

/** A pickable field discovered in a step's live sample — a dot-path + a value preview. */
interface SampleField {
  /** Path appended to the step ref to form `{{refKey.path}}`. */
  path: string;
  /** A short, one-line preview of the value at that path. */
  preview: string;
}

/** An earlier step whose output the current node may reference. */
interface UpstreamStep {
  /** The token key the runtime resolves against: the node id, or `trigger`. */
  refKey: string;
  /** The step's node id — shown so the reference `{{id}}` stays legible. */
  id: string;
  /** Human label for the menu. */
  name: string;
  isTrigger: boolean;
  /** Pick targets flattened from the live sample; absent until the step has been tested. */
  fields?: SampleField[];
}

/** A compact one-line preview of a sample value for the picker menu. */
function previewValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 32 ? `"${v.slice(0, 31)}…"` : `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[ ${v.length} item${v.length === 1 ? "" : "s"} ]`;
  if (typeof v === "object") {
    const n = Object.keys(v as Record<string, unknown>).length;
    return `{ ${n} field${n === 1 ? "" : "s"} }`;
  }
  return String(v);
}

/**
 * Flattens a sample into pickable paths, offering every level. Arrays are leaves, and depth/count
 * are bounded, so a large collection can't flood the menu.
 */
function sampleFields(sample: unknown): SampleField[] {
  const out: SampleField[] = [];
  const MAX = 60;
  const MAX_DEPTH = 5;
  const walk = (value: unknown, path: string, depth: number): void => {
    if (out.length >= MAX) return;
    if (path) out.push({ path, preview: previewValue(value) });
    const isPlainObject = value !== null && typeof value === "object" && !Array.isArray(value);
    if (isPlainObject && depth < MAX_DEPTH) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (out.length >= MAX) break;
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(sample, "", 0);
  return out;
}

/** Distinct upstream step ids referenced by `{{stepId.path}}` tokens in a step's props. */
function referencedRoots(params: Record<string, unknown>): string[] {
  const roots = new Set<string>();
  const RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RE.exec(v)) !== null) {
        const ref = (m[1] ?? "").trim();
        if (ref.startsWith("$")) continue; // reserved (e.g. {{$auth.token}}) — never a step ref
        const root = ref.split(".")[0]?.trim();
        if (root) roots.add(root);
      }
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v !== null && typeof v === "object") {
      Object.values(v).forEach(scan);
    }
  };
  scan(params);
  return [...roots];
}

// Must mirror the service's `isTriggerNode`: triggers compile away and land in scope as `trigger`,
// so a reference to one is `{{trigger.path}}`, never `{{<nodeId>.path}}`.
function isTriggerNodeType(nodeType?: string): boolean {
  if (!nodeType) return false;
  return (
    nodeType === "orchestr:webhook" ||
    nodeType === "orchestr:schedule" ||
    nodeType === "orchestr:chat" ||
    /trigger$/i.test(nodeType)
  );
}

/** Node-aware trigger check: an app trigger's type doesn't end in "trigger", so the marker decides. */
function nodeIsTrigger(node: { node_type?: string; metadata?: Record<string, unknown> }): boolean {
  return isTriggerNodeType(node.node_type) || node.metadata?.trigger === true;
}

// Routers never write `scope[<id>]` at run time, so offering one would mint a token the reference
// resolver can never satisfy.
function producesScopeOutput(node: IrNodeShape): boolean {
  return node.node_type !== "orchestr:if" && node.node_type !== "orchestr:switch";
}

/**
 * The transitive ancestors of `nodeId` in document order — the only steps guaranteed in scope when
 * it runs. A trigger surfaces under the `trigger` key; otherwise `refKey` IS the node id, because
 * the runtime resolves `{{stepId.path}}` against `scope[stepId]`.
 */
function upstreamStepsFor(doc: Record<string, unknown>, nodeId: string): UpstreamStep[] {
  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []) as IrNodeShape[];
  const edges = (Array.isArray(doc.edges) ? doc.edges : []) as Array<{
    source_node_id?: string;
    target_node_id?: string;
  }>;
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.source_node_id || !e.target_node_id) continue;
    const list = parents.get(e.target_node_id) ?? [];
    list.push(e.source_node_id);
    parents.set(e.target_node_id, list);
  }
  const ancestors = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const p of parents.get(cur) ?? []) {
      if (p === nodeId || ancestors.has(p)) continue;
      ancestors.add(p);
      queue.push(p);
    }
  }
  const out: UpstreamStep[] = [];
  for (const n of nodes) {
    if (!n.id || !ancestors.has(n.id)) continue;
    if (!producesScopeOutput(n)) continue;
    const isTrigger = nodeIsTrigger(n);
    out.push({
      refKey: isTrigger ? "trigger" : n.id,
      id: n.id,
      name: n.name && n.name.trim() ? n.name : n.id,
      isTrigger,
    });
  }
  return out;
}

/** What a field's `{{ref}}` tokens resolve to: the interpolated text, or the un-sampled step keys. */
type RefPreview = { kind: "resolved"; text: string } | { kind: "missing"; steps: string[] };

const PREVIEW_MAX = 80;

/**
 * Client-side twin of the runtime's string interpolation, for the field preview. Returns null when
 * there is nothing to preview: no refs, or a reserved `{{$…}}` ref the runtime owns.
 */
function resolveRefsPreview(value: string, samples: Record<string, unknown>): RefPreview | null {
  const REF = /\{\{\s*([^}]+?)\s*\}\}/g;
  if (!REF.test(value)) return null;
  REF.lastIndex = 0;
  let reserved = false;
  const missing = new Set<string>();
  const out = value.replace(REF, (_m, ref: string) => {
    const segments = ref.split(".").map((x: string) => x.trim());
    const root = segments[0] ?? "";
    if (!root || root.startsWith("$")) {
      reserved = true; // `$`-space (e.g. {{$auth.token}}) is the runtime's — don't preview it
      return "";
    }
    if (!Object.prototype.hasOwnProperty.call(samples, root)) {
      missing.add(root); // the referenced step hasn't been sampled yet
      return "";
    }
    let cur: unknown = samples[root];
    for (const key of segments.slice(1)) {
      if (cur === null || cur === undefined) break;
      cur = (cur as Record<string, unknown>)[key];
    }
    if (cur === null || cur === undefined) return ""; // field absent in the sample → empty, not "no sample"
    if (typeof cur === "string") return cur;
    if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
    return JSON.stringify(cur) ?? "";
  });
  if (reserved) return null;
  if (missing.size > 0) return { kind: "missing", steps: [...missing] };
  const oneLine = out.replace(/\s+/g, " ").trim();
  const text = oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX - 1)}…` : oneLine;
  return { kind: "resolved", text };
}

/** A quiet "no sample yet" nudge naming the un-sampled step(s) a field references. */
function missingSampleHint(steps: string[], upstream: UpstreamStep[]): string {
  const nameFor = (refKey: string): string =>
    refKey === "trigger" ? "the trigger" : `"${upstream.find((u) => u.refKey === refKey)?.name ?? refKey}"`;
  return steps.length === 1
    ? `no sample yet — test ${nameFor(steps[0]!)}`
    : "no sample yet — test those steps";
}

/**
 * Mints an ephemeral catch URL; the payload the user fires at it becomes the trigger's sample.
 * Nothing is registered and nothing runs.
 */
function TriggerCatch({
  onSample,
  pasteOnly,
}: {
  onSample: (payload: unknown) => void;
  /** Paste-as-sample only: app triggers arrive over the provider's rail, so a catch URL would mislead. */
  pasteOnly?: boolean;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "waiting"; catchId: string; url: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const [copied, setCopied] = useState<null | "url" | "curl">(null);
  // The no-sender path: pasted JSON becomes the sample without a catch.
  const [pasteOpen, setPasteOpen] = useState(Boolean(pasteOnly));
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const usePasted = () => {
    try {
      const parsed: unknown = JSON.parse(pasteText);
      if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
      setPasteError(null);
      onSample(parsed);
    } catch {
      setPasteError('That isn\'t valid JSON — an event looks like {"email": "sara@acme.com", "plan": "pro"}.');
    }
  };
  const pasteBlock = pasteOpen ? (
    <div className="flex flex-col gap-1 mt-1">
      <textarea
        value={pasteText}
        onChange={(e) => setPasteText(e.target.value)}
        placeholder='{"email": "sara@acme.com", "plan": "pro"}'
        rows={3}
        aria-label="Sample event JSON"
        className="w-full text-[10px] font-mono px-1.5 py-1 rounded outline-none resize-none"
        style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
      />
      {pasteError && (
        <p className="text-[10px] m-0" style={{ color: "var(--orchestr-danger)" }}>
          {pasteError}
        </p>
      )}
      <button
        type="button"
        onClick={usePasted}
        disabled={!pasteText.trim()}
        className="self-start text-[10px] px-1.5 py-1 rounded cursor-pointer disabled:opacity-40"
        style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
        data-testid="trigger-paste-use"
      >
        Use as sample
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setPasteOpen(true)}
      className="self-start text-[10px] px-0 py-0 bg-transparent border-none underline cursor-pointer"
      style={{ color: "var(--orchestr-ink-subtle)" }}
      data-testid="trigger-paste-open"
    >
      No sender handy? Paste a sample event
    </button>
  );

  useEffect(() => {
    if (state.phase !== "waiting") return;
    const { catchId } = state;
    const timer = setInterval(() => {
      api
        .getCatch(catchId)
        .then((res) => {
          if (res.received) onSample(res.payload);
        })
        .catch(() => setState({ phase: "error", message: "The catch expired — mint a new one." }));
    }, 2000);
    return () => clearInterval(timer);
  }, [state, onSample]);

  if (pasteOnly) {
    return <div className="px-3 pb-1.5 pt-0.5 flex flex-col gap-1">{pasteBlock}</div>;
  }

  if (state.phase === "idle" || state.phase === "error") {
    return (
      <div className="px-3 pb-1.5 pt-0.5 flex flex-col gap-1">
        {state.phase === "error" && (
          <p className="text-[10px] m-0 mb-1" style={{ color: "var(--orchestr-danger)" }}>
            {state.message}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            void api
              .createCatch()
              .then((h) =>
                setState({ phase: "waiting", catchId: h.catch_id, url: api.absoluteApiUrl(h.path) }),
              )
              .catch((e) =>
                setState({ phase: "error", message: e instanceof Error ? e.message : "Couldn't start a catch." }),
              );
          }}
          className="self-start text-[11px] px-2 py-1 rounded-lg cursor-pointer"
          style={{
            background: "var(--orchestr-field)",
            border: "1px solid var(--orchestr-line)",
            color: "var(--orchestr-ink)",
          }}
          data-testid="trigger-catch-start"
        >
          Send a test event — I&apos;ll catch it
        </button>
        {pasteBlock}
      </div>
    );
  }
  const copy = (kind: "url" | "curl", text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    });
  };
  const curlCommand = `curl -X POST ${state.url} -H 'Content-Type: application/json' -d '{"email": "sara@acme.com", "plan": "pro"}'`;
  return (
    <div className="px-3 pb-1.5 pt-0.5 flex flex-col gap-1" data-testid="trigger-catch-waiting">
      <div className="flex items-center gap-1">
        <code
          className="flex-1 min-w-0 truncate text-[10px] px-1.5 py-1 rounded"
          style={{ background: "var(--orchestr-field)", color: "var(--orchestr-ink-muted)" }}
          title={state.url}
        >
          {state.url}
        </code>
        <button
          type="button"
          onClick={() => copy("url", state.url)}
          className="shrink-0 text-[10px] px-1.5 py-1 rounded cursor-pointer"
          style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink-subtle)" }}
        >
          {copied === "url" ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={() => copy("curl", curlCommand)}
          title={curlCommand}
          className="shrink-0 text-[10px] px-1.5 py-1 rounded cursor-pointer"
          style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink-subtle)" }}
        >
          {copied === "curl" ? "Copied" : "Copy curl"}
        </button>
      </div>
      {/* A pulsing dot, not a loader: this is a LISTENING state (owner read the
          spinner as "stuck") — nothing is loading until an event arrives. */}
      <p className="text-[10px] m-0 inline-flex items-center gap-1.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
          style={{ background: "var(--orchestr-success)" }}
        />
        Listening — the event is whatever will start this workflow for real: submit your form, fire your
        app&apos;s webhook at this address, or run the curl. Its fields appear here.
      </p>
      {pasteBlock}
    </div>
  );
}

/** A text field whose picker drops a `{{stepId}}` reference to an upstream step at the cursor. */
function ReferenceTextInput({
  value,
  onChange,
  ariaLabel,
  upstream,
  samples,
  onTriggerSample,
  multiline = false,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  upstream: UpstreamStep[];
  samples: Record<string, unknown>;
  onTriggerSample: (payload: unknown) => void;
  /** Long-text props: a textarea, because an `<input>` strips the newlines out of the value. */
  multiline?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const caretRef = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ top: number; left: number; width: number } | null>(null);

  // The value round-trips through the store, so the caret can only be restored after it re-renders.
  useLayoutEffect(() => {
    if (caretRef.current === null || !inputRef.current) return;
    const caret = caretRef.current;
    caretRef.current = null;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(caret, caret);
  }, [value]);

  // Escape closes; a scroll/resize invalidates the fixed anchor, so close too.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // `caretInside` parks the caret before the closing `}}`, so `.field` appends cleanly.
  const insertToken = (token: string, caretInside: boolean) => {
    const el = inputRef.current;
    const cur = value ?? "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    caretRef.current = caretInside ? start + token.length - 2 : start + token.length;
    onChange(cur.slice(0, start) + token + cur.slice(end));
    setMenu(null);
  };

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 300;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setMenu({ top: r.bottom + 4, left, width });
  };

  const preview = resolveRefsPreview(value, samples);
  return (
    <div className="flex flex-col gap-0.5">
    <div className={`flex gap-1 ${multiline ? "items-start" : "items-center"}`}>
      {multiline ? (
        <textarea
          ref={(el) => {
            inputRef.current = el;
          }}
          value={value}
          rows={5}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel}
          className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-[12px] outline-none resize-y"
          style={FIELD_STYLE}
        />
      ) : (
        <input
          ref={(el) => {
            inputRef.current = el;
          }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel}
          className="flex-1 min-w-0 h-8 px-2 rounded-lg text-[12px] outline-none"
          style={FIELD_STYLE}
        />
      )}
      {upstream.length > 0 && (
        <button
          ref={btnRef}
          type="button"
          onClick={() => (menu ? setMenu(null) : openMenu())}
          aria-label="Insert data from an earlier step"
          title="Insert data from an earlier step"
          className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg cursor-pointer"
          style={{
            background: "var(--orchestr-field)",
            border: "1px solid var(--orchestr-line)",
            color: "var(--orchestr-ink-subtle)",
          }}
        >
          <Braces size={13} />
        </button>
      )}
      {menu &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
            <div
              role="menu"
              aria-label="Insert a reference to an earlier step"
              className="fixed z-50 rounded-xl py-1.5 overflow-y-auto"
              style={{
                top: menu.top,
                left: menu.left,
                width: menu.width,
                maxHeight: 300,
                background: "var(--orchestr-surface-card)",
                border: "1px solid var(--orchestr-line)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              }}
            >
              <div
                className="px-3 pt-1 pb-1.5 text-[10px] leading-snug"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                Insert data from an earlier step. Test a step to pick its individual{" "}
                <span className="font-mono">.field</span>s.
              </div>
              {upstream.map((s, i) => {
                const fields = s.fields ?? [];
                const label = s.isTrigger ? "Trigger payload" : s.name;
                return (
                  <div
                    key={s.id}
                    style={i > 0 ? { borderTop: "1px solid var(--orchestr-line)" } : undefined}
                  >
                    <div className="px-3 pt-1.5 pb-0.5 flex items-baseline justify-between gap-2">
                      <span
                        className="text-[11px] font-medium truncate"
                        style={{ color: "var(--orchestr-ink)" }}
                      >
                        {label}
                      </span>
                      <span
                        className="text-[9px] font-mono shrink-0"
                        style={{ color: "var(--orchestr-ink-subtle)" }}
                      >{`{{${s.refKey}}}`}</span>
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => insertToken(`{{${s.refKey}}}`, true)}
                      className="w-full text-left px-3 py-1 text-[12px] cursor-pointer hover:bg-[color:var(--orchestr-accent-tint)]"
                      style={{ color: "var(--orchestr-ink)" }}
                    >
                      {fields.length > 0 ? "Entire output" : s.isTrigger ? "Insert payload" : "Insert output"}
                    </button>
                    {fields.map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        role="menuitem"
                        onClick={() => insertToken(`{{${s.refKey}.${f.path}}}`, false)}
                        className="w-full text-left pl-5 pr-3 py-1 flex items-baseline justify-between gap-2 cursor-pointer hover:bg-[color:var(--orchestr-accent-tint)]"
                        style={{ color: "var(--orchestr-ink)" }}
                      >
                        <span className="text-[11px] font-mono truncate">.{f.path}</span>
                        <span
                          className="text-[10px] font-mono shrink-0 truncate max-w-[110px]"
                          style={{ color: "var(--orchestr-ink-subtle)" }}
                        >
                          {f.preview}
                        </span>
                      </button>
                    ))}
                    {fields.length === 0 && s.isTrigger && <TriggerCatch onSample={onTriggerSample} />}
                    {fields.length === 0 && !s.isTrigger && (
                      <div
                        className="px-3 pb-1.5 pt-0.5 text-[9px] leading-snug"
                        style={{ color: "var(--orchestr-ink-subtle)" }}
                      >
                        Open this step and Test it to list its fields.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
    {preview &&
      (preview.kind === "resolved" ? (
        <p
          className="text-[10px] m-0 px-0.5 truncate"
          style={{ color: "var(--orchestr-ink-subtle)" }}
          title={preview.text}
          data-testid="ref-preview"
        >
          → {preview.text === "" ? "(empty)" : preview.text}
        </p>
      ) : (
        <p
          className="text-[10px] m-0 px-0.5 truncate"
          style={{ color: "var(--orchestr-ink-subtle)" }}
          data-testid="ref-preview-missing"
        >
          → {missingSampleHint(preview.steps, upstream)}
        </p>
      ))}
    </div>
  );
}

// Native canvas trigger kinds (ADR 0018): the node_types the service's isTriggerNode recognises.
const MANUAL_TRIGGER = "orchestr:trigger";
const WEBHOOK_TRIGGER = "orchestr:webhook";
const SCHEDULE_TRIGGER = "orchestr:schedule";
const CHAT_TRIGGER = "orchestr:chat";
const TOOL_TRIGGER = "orchestr:tool_trigger";
// Unconfigured, the webhook/chat endpoints below are a GUESS and the copy has to say so.
const API_URL_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_API_URL);
// The browser's own origin is the fallback (correct behind a same-origin proxy), never a
// hard-coded localhost an outside caller can't reach. Resolved via config, so the same-origin
// build renders the real origin rather than its sentinel.
function apiOrigin(): string {
  if (apiBaseUrl) return apiBaseUrl;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:8001";
}
// The chat endpoint is env-scoped: it goes live once a version carrying the trigger is promoted here.
const CHAT_ENV = "production";

type TriggerKind = "manual" | "webhook" | "schedule" | "chat" | "tool" | "app";
function kindOf(nodeType?: string): TriggerKind {
  if (nodeType === WEBHOOK_TRIGGER) return "webhook";
  if (nodeType === SCHEDULE_TRIGGER) return "schedule";
  if (nodeType === CHAT_TRIGGER) return "chat";
  if (nodeType === TOOL_TRIGGER) return "tool";
  // An app trigger's type is "<app>.<trigger>" (e.g. gmail.gmail_new_email_received).
  if (nodeType && nodeType.includes(".")) return "app";
  return "manual";
}

/** THE reply-rendering seam: turns the terminal node's unknown-shaped output into display text. */
function renderReply(reply: unknown): string {
  if (reply === null || reply === undefined) return "";
  if (typeof reply === "string") return reply;
  if (typeof reply === "number" || typeof reply === "boolean") return String(reply);
  if (typeof reply === "object") {
    const o = reply as Record<string, unknown>;
    for (const key of ["text", "message", "reply", "output"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
    try {
      return JSON.stringify(reply, null, 2);
    } catch {
      return String(reply);
    }
  }
  return String(reply);
}

interface ChatTryItTurn {
  role: "user" | "assistant";
  /** User message, or the assistant's final reply once the run completes. */
  text?: string;
  /** Assistant only — the live agent trace (model turns + tool calls). */
  steps?: AgentStep[];
  /** Assistant only — the run is still in flight. */
  streaming?: boolean;
  /** Assistant only — the POST failed (styles the bubble as an error). */
  errored?: boolean;
}

/** Client-minted so the panel can subscribe to the step stream before POSTing under the same id. */
function newChatSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through to the time+random fallback
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** One-line, truncated preview of a tool's input/output for the compact trace. */
function compactStepValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}

/** The live agent trace for one assistant turn: model turns and tool calls as the SSE frames arrive. */
function AgentStepTrace({ steps, streaming }: { steps: AgentStep[]; streaming?: boolean }) {
  // The final answer is rendered as the reply bubble, not inside the trace.
  const visible = steps.filter((s) => s.kind !== "final");
  if (visible.length === 0 && !streaming) return null;
  return (
    <div
      className="w-full rounded-lg px-2 py-1.5 space-y-1.5"
      style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)" }}
      data-testid="agent-step-trace"
    >
      {visible.map((s, i) =>
        s.kind === "tool" ? (
          <div
            key={i}
            className="flex items-start gap-1.5 text-[10.5px]"
            style={{ color: "var(--orchestr-ink-muted)" }}
            data-testid="agent-step-tool"
          >
            <Wrench size={11} className="mt-[1px] shrink-0" style={{ color: "var(--orchestr-ai)" }} />
            <div className="min-w-0">
              <span className="font-medium" style={{ color: "var(--orchestr-ink)" }}>
                {s.tool ?? "tool"}
              </span>
              {compactStepValue(s.input) && (
                <div className="font-mono truncate" style={{ color: "var(--orchestr-ink-muted)" }}>
                  → {compactStepValue(s.input)}
                </div>
              )}
              {compactStepValue(s.output) && (
                <div className="font-mono truncate" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  ← {compactStepValue(s.output)}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            key={i}
            className="flex items-start gap-1.5 text-[10.5px]"
            style={{ color: "var(--orchestr-ink-subtle)" }}
            data-testid="agent-step-model"
          >
            <Sparkles size={11} className="mt-[1px] shrink-0" />
            <span className="min-w-0 truncate">{s.text && s.text.trim() ? s.text.trim() : "Thinking…"}</span>
          </div>
        ),
      )}
      {streaming && (
        <div className="flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--orchestr-ai)" }} />
          Working…
        </div>
      )}
    </div>
  );
}

/**
 * In-panel "try it" chat for the orchestr:chat trigger: each Send subscribes to the step stream
 * first, then POSTs under the same session id. It exercises the LIVE production version, so it only
 * replies once a version carrying this trigger has been promoted.
 */
function ChatTryIt({ workflowId, placeholder }: { workflowId: string; placeholder?: string }) {
  const [turns, setTurns] = useState<ChatTryItTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Gates Send: with nothing promoted the POST just 404s. `null` = loading, and Send stays enabled.
  const [promoted, setPromoted] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getWorkflow(workflowId)
      .then((wf) => {
        if (!cancelled) setPromoted(wf.live_version != null);
      })
      .catch(() => {
        if (!cancelled) setPromoted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, busy]);

  // Close any open EventSource on unmount, or the stream leaks and auto-reconnects.
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  // Patch the in-flight assistant turn (the last streaming one).
  const patchStreamingTurn = (patch: (turn: ChatTryItTurn) => ChatTryItTurn) =>
    setTurns((t) => {
      const next = [...t];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.role === "assistant" && next[i]!.streaming) {
          next[i] = patch(next[i]!);
          break;
        }
      }
      return next;
    });

  const closeStream = (es: EventSource) => {
    es.close();
    if (esRef.current === es) esRef.current = null;
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy || promoted === false) return;
    setInput("");
    setError(null);
    const sessionId = (sessionRef.current ??= newChatSessionId());
    setTurns((t) => [...t, { role: "user", text }, { role: "assistant", steps: [], streaming: true }]);
    setBusy(true);

    // Subscribe to the step stream before posting.
    const es = api.streamChatEvents(workflowId, CHAT_ENV, sessionId, (step) => {
      patchStreamingTurn((turn) => ({ ...turn, steps: [...(turn.steps ?? []), step] }));
    });
    esRef.current = es;
    es.onerror = () => {
      // Stop on any stream error so the browser doesn't auto-reconnect; the POST is authoritative.
      closeStream(es);
    };

    void api
      .postChatMessage(workflowId, CHAT_ENV, { chatInput: text, sessionId })
      .then((res) => {
        const reply = renderReply(res.reply).trim();
        patchStreamingTurn((turn) => ({ ...turn, streaming: false, text: reply || "(the workflow returned no reply)" }));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Couldn't reach the chat endpoint.");
        patchStreamingTurn((turn) => ({ ...turn, streaming: false, errored: true, text: "" }));
      })
      .finally(() => {
        closeStream(es);
        setBusy(false);
      });
  };

  return (
    <div
      className="rounded-md p-2.5 space-y-2"
      style={{ border: "1px solid var(--orchestr-line)" }}
      data-testid="chat-tryit"
    >
      <div className="flex items-center gap-1.5">
        <MessageCircle size={12} style={{ color: "var(--orchestr-ink-muted)" }} />
        <span className="text-[11px] font-medium" style={{ color: "var(--orchestr-ink)" }}>
          Try it
        </span>
      </div>

      <div
        ref={logRef}
        className="rounded-md px-2 py-2 space-y-1.5 overflow-y-auto"
        style={{ maxHeight: 240, minHeight: 56, background: "var(--orchestr-field)" }}
      >
        {turns.length === 0 && !busy && (
          <p className="text-[10.5px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Send a message to run the LIVE production workflow — {REAL_RUN_CONSEQUENCE} Agent steps — each
            tool call and the final answer — stream in as it works.
          </p>
        )}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <span
                className="text-[11px] rounded-lg px-2 py-1 whitespace-pre-wrap break-words"
                style={{ maxWidth: "85%", background: "var(--orchestr-ai)", color: "#fff" }}
              >
                {turn.text}
              </span>
            </div>
          ) : (
            <div key={i} className="flex flex-col items-start gap-1.5 w-full">
              {turn.steps && (turn.steps.length > 0 || turn.streaming) && (
                <AgentStepTrace steps={turn.steps} streaming={turn.streaming} />
              )}
              {turn.text ? (
                <span
                  className="text-[11px] rounded-lg px-2 py-1 whitespace-pre-wrap break-words"
                  style={{
                    maxWidth: "85%",
                    background: "var(--orchestr-surface-raised)",
                    color: turn.errored ? "var(--orchestr-danger)" : "var(--orchestr-ink)",
                  }}
                  data-testid="chat-tryit-reply"
                >
                  {turn.text}
                </span>
              ) : (
                turn.streaming &&
                (!turn.steps || turn.steps.length === 0) && (
                  <span
                    className="text-[11px] rounded-lg px-2 py-1 inline-flex items-center gap-1.5"
                    style={{ background: "var(--orchestr-surface-raised)", color: "var(--orchestr-ink-subtle)" }}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ background: "var(--orchestr-ink-subtle)" }}
                    />
                    Running…
                  </span>
                )
              )}
            </div>
          ),
        )}
      </div>

      {error && (
        <p className="text-[10.5px] m-0" style={{ color: "var(--orchestr-danger)" }} data-testid="chat-tryit-error">
          {error}
        </p>
      )}

      {/* Nothing promoted → the live endpoint is dark; say so and block Send here
          rather than let the POST 404 after the user hits enter (UX audit B6). */}
      {promoted === false && (
        <p
          className="text-[10.5px] m-0 flex items-start gap-1"
          style={{ color: "var(--orchestr-warning)" }}
          data-testid="chat-tryit-not-promoted"
        >
          <AlertTriangle size={11} className="shrink-0 mt-[1px]" />
          <span>Promote a version to production to try it — the live chat endpoint is dark until then.</span>
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder || "Type a message…"}
          aria-label="Chat message"
          disabled={promoted === false}
          className="flex-1 min-w-0 h-8 px-2 rounded-lg text-[12px] outline-none disabled:opacity-50"
          style={{
            background: "var(--orchestr-surface-raised)",
            border: "1px solid var(--orchestr-line-strong)",
            color: "var(--orchestr-ink)",
          }}
        />
        <button
          type="button"
          onClick={send}
          disabled={!input.trim() || busy || promoted === false}
          aria-label="Send"
          className="shrink-0 h-8 px-2.5 flex items-center gap-1 rounded-lg text-[11px] cursor-pointer disabled:opacity-50"
          style={{ background: "var(--orchestr-ai)", color: "#fff", border: "none" }}
        >
          <Send size={12} /> Send
        </button>
      </div>
    </div>
  );
}

/** One selectable row in the trigger catalog picker. */
function TriggerOption({
  nodeType,
  name,
  badge,
  desc,
  active,
  onClick,
}: {
  nodeType?: string;
  name: string;
  badge?: string;
  desc?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded px-2 py-1.5 cursor-pointer border-none block"
      style={{ background: active ? "var(--orchestr-accent-tint)" : "transparent" }}
    >
      <div className="flex items-center gap-2">
        {nodeType && <NodeIcon nodeType={nodeType} size={20} className="shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-medium truncate" style={{ color: "var(--orchestr-ink)" }}>
              {name}
            </span>
            {badge && (
              <span
                className="text-[8.5px] uppercase tracking-wide px-1 py-[1px] rounded shrink-0"
                style={{ background: "var(--orchestr-surface-raised)", color: "var(--orchestr-ink-subtle)" }}
              >
                {badge}
              </span>
            )}
          </div>
          {desc && (
            <p className="text-[10.5px] m-0 mt-0.5 truncate" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {desc}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * Trigger config for the canvas trigger node (ADR 0018): the trigger is an ordinary node, so picking
 * one re-types it in place. App triggers carry `metadata.trigger` and resolve their connection from
 * the environment slot, never from the node. Save ≠ Live — a promoted version activates it.
 */
function TriggerTypeConfig({
  node,
  workflowId,
  updateIrNode,
  samples,
  onTriggerSample,
  onClearTriggerSample,
}: {
  node: IrNodeShape;
  workflowId: string | null;
  updateIrNode: (
    id: string,
    patch: { node_type?: string; parameters?: Record<string, unknown>; metadata?: Record<string, unknown> },
  ) => void;
  samples: Record<string, unknown>;
  onTriggerSample: (payload: unknown) => void;
  onClearTriggerSample: () => void;
}) {
  const [catalog, setCatalog] = useState<TriggerCatalogEntry[] | null>(null);
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);

  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .listTriggerCatalog()
      .then((r) => {
        if (!alive) return;
        setCatalog(r.triggers);
        setCatalogError(null);
      })
      .catch((e: unknown) => {
        if (alive) setCatalogError(e instanceof Error ? e.message : "Failed to load triggers");
      });
    return () => {
      alive = false;
    };
  }, [catalogEpoch]);

  const type = node.node_type ?? MANUAL_TRIGGER;
  const kind = kindOf(type);
  const current = catalog?.find((e) => e.type === type) ?? null;
  const params = (node.parameters as Record<string, unknown>) ?? {};
  const webhookUrl = workflowId ? `${apiOrigin()}/api/hooks/${workflowId}/production` : null;
  const chatUrl = workflowId ? `${apiOrigin()}/api/chat/${workflowId}/${CHAT_ENV}` : null;

  const pick = (entry: TriggerCatalogEntry) => {
    // Native control triggers carry no connection and no marker; the service knows them by node_type.
    const native =
      entry.type === WEBHOOK_TRIGGER ||
      entry.type === SCHEDULE_TRIGGER ||
      entry.type === CHAT_TRIGGER ||
      entry.type === TOOL_TRIGGER;
    updateIrNode(node.id, {
      node_type: entry.type,
      parameters:
        entry.type === SCHEDULE_TRIGGER
          ? { interval_minutes: 15 }
          : entry.type === CHAT_TRIGGER
            ? defaultParamsFromSchema(entry.parameters)
            : native
              ? {}
              : defaultParamsFromSchema(entry.parameters),
      metadata: native ? {} : { trigger: true },
    });
    setPicking(false);
    setQ("");
  };
  const pickManual = () => {
    updateIrNode(node.id, { node_type: MANUAL_TRIGGER, parameters: {}, metadata: {} });
    setPicking(false);
    setQ("");
  };
  const setParam = (key: string, value: unknown) => updateIrNode(node.id, { parameters: { ...params, [key]: value } });
  // undefined DROPS the key: an off toggle must leave no verification block for fire-time to trip on.
  const setVerification = (value: WebhookVerification | undefined) => {
    const next = { ...params };
    if (value === undefined) delete next.verification;
    else next.verification = value;
    updateIrNode(node.id, { parameters: next });
  };

  const label =
    kind === "manual"
      ? "Manual"
      : kind === "webhook"
        ? "Webhook"
        : kind === "schedule"
          ? "Schedule"
          : kind === "chat"
            ? "Chat"
            : kind === "tool"
              ? "Called by another workflow"
              : (current?.name ?? getNodeTypeLabel(type));
  const HeadIcon =
    kind === "webhook"
      ? Webhook
      : kind === "schedule"
        ? Clock
        : kind === "chat"
          ? MessageCircle
          : kind === "tool"
            ? Workflow
            : Zap;

  const query = q.trim().toLowerCase();
  const TRIGGER_CAP = 60;
  const matches = (catalog ?? []).filter(
    (e) =>
      !query ||
      e.name.toLowerCase().includes(query) ||
      e.type.toLowerCase().includes(query) ||
      (e.category ?? "").toLowerCase().includes(query),
  );
  // Browsing shows only the native kinds; the hundreds of app triggers are search-driven and capped.
  const browsing = !query;
  const results = browsing ? matches.filter((e) => e.type.startsWith("orchestr:")) : matches.slice(0, TRIGGER_CAP);
  const moreCount = browsing ? 0 : matches.length - results.length;

  return (
    <div className="space-y-2" data-testid="trigger-type-config">
      <label className="block text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
        How this workflow starts
      </label>

      {/* Current trigger + Change */}
      <div
        className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
        style={{ borderColor: "var(--orchestr-line-strong)", background: "var(--orchestr-surface-raised)" }}
      >
        <div className="flex items-center gap-1.5 min-w-0 text-[12px]" style={{ color: "var(--orchestr-ink)" }}>
          <HeadIcon size={13} className="shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <button
          onClick={() => setPicking((p) => !p)}
          className="text-[11px] shrink-0 bg-transparent border-none cursor-pointer p-0"
          style={{ color: "var(--orchestr-accent)" }}
        >
          {picking ? "Close" : "Change"}
        </button>
      </div>

      {/* Catalog picker — the full set of triggers */}
      {picking && (
        <div
          className="rounded-md border p-1.5 space-y-1"
          style={{ borderColor: "var(--orchestr-line)", background: "var(--orchestr-surface-card)" }}
        >
          <div className="flex items-center gap-1.5 rounded px-2 py-1" style={{ background: "var(--orchestr-surface-raised)" }}>
            <Search size={12} style={{ color: "var(--orchestr-ink-subtle)" }} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search triggers…"
              className="flex-1 bg-transparent text-[12px] outline-none"
              style={{ color: "var(--orchestr-ink)" }}
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {catalogError ? (
              <InlineError
                message={catalogError}
                onRetry={() => {
                  setCatalogError(null);
                  setCatalogEpoch((n) => n + 1);
                }}
              />
            ) : catalog === null ? (
              <div className="py-3 flex justify-center">
                <SaratiLoader size={18} />
              </div>
            ) : (
              <>
                {!query && (
                  <TriggerOption
                    nodeType={MANUAL_TRIGGER}
                    name="Manual"
                    desc="Run on demand — no automatic trigger"
                    active={kind === "manual"}
                    onClick={pickManual}
                  />
                )}
                {results.map((e) => (
                  <TriggerOption
                    key={e.type}
                    nodeType={e.type}
                    name={e.name}
                    badge={
                      e.category && e.category !== "control"
                        ? e.category
                        : e.type.includes(".")
                          ? e.type.split(".")[0]
                          : undefined
                    }
                    desc={e.description}
                    active={e.type === type}
                    onClick={() => pick(e)}
                  />
                ))}
                {browsing && (
                  <p className="text-[10.5px] px-2 py-2 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    Search {catalog && catalog.length > 20 ? `${catalog.length}+ ` : ""}app triggers — Slack, GitHub,
                    Gmail, Stripe, Notion, …
                  </p>
                )}
                {moreCount > 0 && (
                  <p className="text-[10.5px] px-2 py-1.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    +{moreCount} more — keep typing to narrow.
                  </p>
                )}
                {!browsing && results.length === 0 && (
                  <p className="text-[11px] px-2 py-2 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    No triggers match “{q}”.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Config for the current kind */}
      {kind === "manual" && (
        <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Runs on demand from the Run panel. Pick a trigger above to fire it automatically.
        </p>
      )}

      {kind === "webhook" &&
        (webhookUrl && workflowId ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div
                className="font-mono text-[10px] break-all rounded-md px-2 py-1.5"
                style={{ background: "var(--orchestr-surface-raised)", color: "var(--orchestr-ink-muted)" }}
              >
                {webhookUrl}
              </div>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(webhookUrl);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="flex items-center gap-1.5 text-[11px] bg-transparent border-none p-0 cursor-pointer"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy URL"}
              </button>
              <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Stable forever. It goes live once you promote a version carrying this trigger to production.
              </p>
              {!API_URL_CONFIGURED && (
                <p className="text-[10px] m-0" style={{ color: "var(--orchestr-warning)" }}>
                  This host is guessed from your browser — set your public base URL
                  (<span className="font-mono">NEXT_PUBLIC_API_URL</span>) so callers reach the right address.
                </p>
              )}
            </div>
            <WebhookVerifySection
              workflowId={workflowId}
              nodeId={node.id}
              verification={(params as { verification?: WebhookVerification }).verification}
              setVerification={setVerification}
            />
          </div>
        ) : (
          <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Save this workflow to get its webhook URL.
          </p>
        ))}

      {kind === "chat" &&
        (chatUrl && workflowId ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div
                className="font-mono text-[10px] break-all rounded-md px-2 py-1.5"
                style={{ background: "var(--orchestr-surface-raised)", color: "var(--orchestr-ink-muted)" }}
              >
                {chatUrl}
              </div>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(chatUrl);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="flex items-center gap-1.5 text-[11px] bg-transparent border-none p-0 cursor-pointer"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy URL"}
              </button>
              <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                POST <span className="font-mono">{`{ chatInput }`}</span> here to run this workflow and get its
                reply. It goes live once you promote a version carrying this trigger to production.
              </p>
              {!API_URL_CONFIGURED && (
                <p className="text-[10px] m-0" style={{ color: "var(--orchestr-warning)" }}>
                  This host is guessed from your browser — set your public base URL
                  (<span className="font-mono">NEXT_PUBLIC_API_URL</span>) so callers reach the right address.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div>
                <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
                  Greeting
                </label>
                <input
                  type="text"
                  value={typeof params.greeting === "string" ? params.greeting : ""}
                  onChange={(e) => setParam("greeting", e.target.value)}
                  placeholder="Hi! How can I help?"
                  className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
                  style={{
                    background: "var(--orchestr-surface-raised)",
                    border: "1px solid var(--orchestr-line-strong)",
                    color: "var(--orchestr-ink)",
                  }}
                />
              </div>
              <div>
                <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
                  Input placeholder
                </label>
                <input
                  type="text"
                  value={typeof params.placeholder === "string" ? params.placeholder : ""}
                  onChange={(e) => setParam("placeholder", e.target.value)}
                  placeholder="Type a message…"
                  className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
                  style={{
                    background: "var(--orchestr-surface-raised)",
                    border: "1px solid var(--orchestr-line-strong)",
                    color: "var(--orchestr-ink)",
                  }}
                />
              </div>
              <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Presentational — shown by a chat surface, they don&apos;t affect how the workflow runs.
              </p>
            </div>

            <ChatTryIt workflowId={workflowId} placeholder={typeof params.placeholder === "string" ? params.placeholder : undefined} />
          </div>
        ) : (
          <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Save this workflow to get its chat endpoint.
          </p>
        ))}

      {kind === "schedule" && (
        <ScheduleTriggerConfig
          params={params}
          setParams={(patch) => {
            // The service requires EXACTLY one of interval_minutes | cron, so a commit must drop
            // the other mode's keys rather than let both linger.
            const next = { ...params };
            delete next.interval_minutes;
            delete next.cron;
            delete next.timezone;
            updateIrNode(node.id, { parameters: { ...next, ...patch } });
          }}
        />
      )}

      {kind === "tool" && (
        <ToolTriggerConfig params={params} setParam={setParam} fallbackName={node.name ?? ""} />
      )}

      {kind === "app" && <AppTriggerConfig entry={current} params={params} setParam={setParam} />}

      {/* "What does this trigger send?" — sample capture on the trigger node itself. */}
      {(kind === "webhook" || kind === "schedule" || kind === "app") && (
        <TriggerSampleSection
          kind={kind}
          exampleEvent={
            kind === "app"
              ? current?.sample
              : kind === "schedule"
                ? {
                    scheduled_at: new Date().toISOString(),
                    timezone: typeof params.timezone === "string" && params.timezone ? params.timezone : "UTC",
                  }
                : undefined
          }
          samples={samples}
          onSample={onTriggerSample}
          onClear={onClearTriggerSample}
        />
      )}
    </div>
  );
}

/**
 * Non-secret HMAC config on the webhook trigger's params (ADR 0030); the secret is set out-of-band
 * and never enters the doc. Verify is enforced only when BOTH this config and a stored secret exist.
 */
interface WebhookVerification {
  preset?: "github" | "shopify" | "stripe" | "generic";
  algo?: "sha1" | "sha256";
  header?: string;
  format?: "hex" | "base64";
  prefix?: string;
}

const WEBHOOK_PRESETS: Record<
  NonNullable<WebhookVerification["preset"]>,
  { label: string; header: string; algo: string; note?: string }
> = {
  github: { label: "GitHub", header: "X-Hub-Signature-256", algo: "SHA-256" },
  shopify: { label: "Shopify", header: "X-Shopify-Hmac-Sha256", algo: "SHA-256" },
  stripe: { label: "Stripe", header: "Stripe-Signature", algo: "SHA-256", note: "Timestamped t=…,v1=… scheme." },
  generic: { label: "Generic / custom", header: "", algo: "" },
};

// Must match the webhook URL's env: the service reads the secret under that env when a delivery fires.
const WEBHOOK_ENV = "production";

const verifyInputStyle: CSSProperties = {
  background: "var(--orchestr-surface-raised)",
  border: "1px solid var(--orchestr-line-strong)",
  color: "var(--orchestr-ink)",
};

/** "Verify signatures" (ADR 0030): a preset fills header + algorithm; the secret is write-only. */
function WebhookVerifySection({
  workflowId,
  nodeId,
  verification,
  setVerification,
}: {
  workflowId: string;
  nodeId: string;
  verification: WebhookVerification | undefined;
  setVerification: (v: WebhookVerification | undefined) => void;
}) {
  const on = verification !== undefined;
  const preset = verification?.preset ?? (verification?.header ? "generic" : "github");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  // Read back from the server, not tracked locally: "Verify on + no secret" silently fails open,
  // so this must reflect what is actually stored. `null` = not loaded.
  const [secretPresent, setSecretPresent] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getWebhookSecretStatus(workflowId, nodeId, WEBHOOK_ENV)
      .then(({ secret_present }) => {
        if (!cancelled) setSecretPresent(secret_present);
      })
      .catch(() => {
        if (!cancelled) setSecretPresent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, nodeId]);

  const choosePreset = (p: NonNullable<WebhookVerification["preset"]>) => {
    setVerification(
      p === "generic"
        ? { preset: "generic", algo: "sha256", header: "x-signature", format: "hex", prefix: "" }
        : { preset: p },
    );
  };

  const saveSecret = async () => {
    if (!secret.trim() || busy) return;
    setBusy(true);
    try {
      await api.setWebhookSecret(workflowId, { node_id: nodeId, secret: secret.trim(), environment: WEBHOOK_ENV });
      setSecret("");
      setSecretPresent(true);
      toast.success("Signing secret saved");
    } catch (e) {
      toast.error("Couldn't save the secret", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { status } = await api.clearWebhookSecret(workflowId, nodeId, WEBHOOK_ENV);
      setSecretPresent(false);
      toast.success(status === "cleared" ? "Signing secret cleared" : "No secret was set");
    } catch (e) {
      toast.error("Couldn't clear the secret", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md p-2.5" style={{ border: "1px solid var(--orchestr-line)" }}>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={() => setVerification(on ? undefined : { preset: "github" })}
          data-testid="webhook-verify-toggle"
        />
        <span className="text-[11px] font-medium" style={{ color: "var(--orchestr-ink)" }}>
          Verify signatures (recommended)
        </span>
      </label>

      {on && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Reject deliveries whose HMAC signature doesn’t match your signing secret.
          </p>

          {/* Verify on with no stored secret means deliveries fire UNVERIFIED, so it reads as danger. */}
          {secretPresent === false ? (
            <div
              className="rounded-lg py-2 px-2.5 text-[11px] flex items-start gap-1.5"
              style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
              data-testid="webhook-verify-unverified"
            >
              <AlertTriangle size={13} className="shrink-0 mt-[1px]" />
              <span>
                <span className="font-semibold">No secret saved — deliveries are NOT verified.</span> Verify
                is on but every incoming webhook fires unchecked until you save a signing secret below.
              </span>
            </div>
          ) : secretPresent === true ? (
            <div
              className="rounded-lg py-1.5 px-2.5 text-[11px] flex items-center gap-1.5"
              style={{ background: "var(--orchestr-success-tint)", color: "var(--orchestr-success)" }}
              data-testid="webhook-verify-active"
            >
              <ShieldCheck size={13} className="shrink-0" />
              <span className="font-semibold">Secret set — verification active.</span>
            </div>
          ) : null}

          <div>
            <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Provider
            </label>
            <select
              value={preset}
              onChange={(e) => choosePreset(e.target.value as NonNullable<WebhookVerification["preset"]>)}
              data-testid="webhook-verify-preset"
              className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
              style={verifyInputStyle}
            >
              {(Object.keys(WEBHOOK_PRESETS) as Array<keyof typeof WEBHOOK_PRESETS>).map((k) => (
                <option key={k} value={k}>
                  {WEBHOOK_PRESETS[k].label}
                </option>
              ))}
            </select>
          </div>

          {preset !== "generic" ? (
            <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Signature read from <code>{WEBHOOK_PRESETS[preset].header}</code> ({WEBHOOK_PRESETS[preset].algo}).
              {WEBHOOK_PRESETS[preset].note ? ` ${WEBHOOK_PRESETS[preset].note}` : ""}
            </p>
          ) : (
            <GenericVerifyFields verification={verification ?? {}} setVerification={setVerification} />
          )}

          <div>
            <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Signing secret
            </label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Paste the provider’s webhook secret"
              data-testid="webhook-secret"
              className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
              style={verifyInputStyle}
            />
            <p className="text-[10px] mt-1 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Stored encrypted, scoped to production, never shown again
              {secretPresent === true ? " — a secret is saved." : secretPresent === false ? " — none saved yet." : "."}
            </p>
            <div className="flex gap-2 mt-1.5">
              <button
                onClick={() => void saveSecret()}
                disabled={!secret.trim() || busy}
                className="text-[11px] px-2 py-1 rounded-md cursor-pointer disabled:opacity-50"
                style={{ background: "var(--orchestr-ai)", color: "#fff", border: "none" }}
              >
                Save secret
              </button>
              <button
                onClick={() => void clearSecret()}
                disabled={busy}
                className="text-[11px] px-2 py-1 rounded-md cursor-pointer bg-transparent disabled:opacity-50"
                style={{ border: "1px solid var(--orchestr-line-strong)", color: "var(--orchestr-ink-muted)" }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Generic preset: expose the header, algorithm, encoding, and optional prefix. */
function GenericVerifyFields({
  verification,
  setVerification,
}: {
  verification: WebhookVerification;
  setVerification: (v: WebhookVerification) => void;
}) {
  const set = (patch: Partial<WebhookVerification>) =>
    setVerification({ ...verification, preset: "generic", ...patch });
  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Signature header
        </label>
        <input
          value={verification.header ?? ""}
          onChange={(e) => set({ header: e.target.value })}
          placeholder="x-signature"
          className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
          style={verifyInputStyle}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
            Algorithm
          </label>
          <select
            value={verification.algo ?? "sha256"}
            onChange={(e) => set({ algo: e.target.value as "sha1" | "sha256" })}
            className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
            style={verifyInputStyle}
          >
            <option value="sha256">SHA-256</option>
            <option value="sha1">SHA-1</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
            Encoding
          </label>
          <select
            value={verification.format ?? "hex"}
            onChange={(e) => set({ format: e.target.value as "hex" | "base64" })}
            className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
            style={verifyInputStyle}
          >
            <option value="hex">hex</option>
            <option value="base64">base64</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Prefix (optional)
        </label>
        <input
          value={verification.prefix ?? ""}
          onChange={(e) => set({ prefix: e.target.value })}
          placeholder="e.g. sha256="
          className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
          style={verifyInputStyle}
        />
      </div>
    </div>
  );
}

/**
 * "Sample event" on the trigger node itself; the payload lands in the same trigger sample every
 * `.field` picker reads. Kind decides the capture affordances.
 */
function TriggerSampleSection({
  kind,
  exampleEvent,
  samples,
  onSample,
  onClear,
}: {
  kind: TriggerKind;
  /** A provider-shaped example payload (SDK-authored `sample`, or the schedule's own shape). */
  exampleEvent?: unknown;
  samples: Record<string, unknown>;
  onSample: (payload: unknown) => void;
  onClear: () => void;
}) {
  const captured = Object.prototype.hasOwnProperty.call(samples, "trigger");
  return (
    <div className="rounded-md p-2.5 space-y-1.5" style={{ border: "1px solid var(--orchestr-line)" }} data-testid="trigger-sample-section">
      <span className="block text-[11px] font-medium" style={{ color: "var(--orchestr-ink)" }}>
        Sample event
      </span>
      {captured ? (
        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--orchestr-ink-muted)" }} data-testid="trigger-sample-chip">
          <Check size={11} style={{ color: "var(--orchestr-success)" }} className="shrink-0" />
          <span>Sample loaded — later steps can pick its fields.</span>
          <button
            type="button"
            onClick={onClear}
            className="ml-auto shrink-0 bg-transparent border-none cursor-pointer underline underline-offset-2 p-0"
            style={{ color: "var(--orchestr-ink-subtle)" }}
            data-testid="trigger-sample-clear"
          >
            Clear
          </button>
        </div>
      ) : (
        <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Load what this trigger sends, so later steps can pick real fields instead of guessing paths.
        </p>
      )}
      {exampleEvent !== undefined && (
        <div>
          <button
            type="button"
            onClick={() => onSample(exampleEvent)}
            className="text-[11px] px-2 py-1 rounded-lg cursor-pointer"
            style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
            data-testid="trigger-sample-example"
          >
            Load the example event
          </button>
          <p className="text-[9px] m-0 mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
            An example of this trigger&apos;s payload — a real delivery can vary.
          </p>
        </div>
      )}
      {(kind === "webhook" || kind === "app") && (
        // -mx-3 rejoins TriggerCatch's own px-3 gutter to this card's padding.
        <div className="-mx-3">
          <TriggerCatch onSample={onSample} pasteOnly={kind === "app"} />
        </div>
      )}
    </div>
  );
}

/** Soft 5-field shape check for a cron expression — the service parses for real at promote. */
function cronLooksMalformed(cron: string): boolean {
  return cron.trim() !== "" && !/^\S+(\s+\S+){4}$/.test(cron.trim());
}

/** The browser's IANA zone list for the cron timezone picker (fallbacks kept tiny). */
function timezoneChoices(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === "function") return Intl.supportedValuesOf("timeZone");
  } catch {
    // very old runtime — fall through
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return local && local !== "UTC" ? ["UTC", local] : ["UTC"];
}

/**
 * Schedule trigger config. The engine takes exactly one of `interval_minutes` | `cron` plus an IANA
 * `timezone`, so the mode select keeps exactly-one-of true by dropping the other mode's params.
 */
/** A parameter value read back as an object map, never an array or a scalar. */
function paramsObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** One argument this workflow declares; the shape the service's `inputsOf` parses. */
interface ToolInputRow {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required: boolean;
}

function toolInputRows(raw: unknown): ToolInputRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const type = typeof row.type === "string" ? row.type : "string";
    return [
      {
        name: typeof row.name === "string" ? row.name : "",
        type: (["string", "number", "boolean", "object"].includes(type) ? type : "string") as ToolInputRow["type"],
        description: typeof row.description === "string" ? row.description : "",
        required: row.required === true,
      },
    ];
  });
}

/**
 * What this workflow tells callers about running it (ADR 0053 §1, ADR 0062). Name and description
 * are load-bearing, not decoration: a caller picks this workflow on the description alone, and one
 * without both is withheld rather than offered — so the panel says so instead of failing later.
 */
function ToolTriggerConfig({
  params,
  setParam,
  fallbackName,
}: {
  params: Record<string, unknown>;
  setParam: (key: string, value: unknown) => void;
  fallbackName: string;
}) {
  const toolName = typeof params.tool_name === "string" ? params.tool_name : "";
  const description = typeof params.description === "string" ? params.description : "";
  const inputs = toolInputRows(params.inputs);
  const setInputs = (next: ToolInputRow[]) => setParam("inputs", next);
  const patchInput = (index: number, patch: Partial<ToolInputRow>) =>
    setInputs(inputs.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const fieldStyle = {
    background: "var(--orchestr-surface-raised)",
    border: "1px solid var(--orchestr-line-strong)",
    color: "var(--orchestr-ink)",
  };

  return (
    <div className="space-y-2.5" data-testid="tool-trigger-config">
      <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Other workflows and AI agents can run this one and use its result. It never fires on its own.
      </p>

      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Name callers see
        </label>
        <input
          value={toolName}
          onChange={(e) => setParam("tool_name", e.target.value)}
          placeholder={fallbackName || "summarize_ticket"}
          aria-label="Name callers see"
          className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
          style={fieldStyle}
          data-testid="tool-trigger-name"
        />
      </div>

      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          What it does
        </label>
        <textarea
          value={description}
          onChange={(e) => setParam("description", e.target.value)}
          rows={2}
          placeholder="Summarizes a support ticket and returns the key points."
          aria-label="What it does"
          className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none resize-y"
          style={fieldStyle}
          data-testid="tool-trigger-description"
        />
        {!description.trim() && (
          <p className="text-[11px] mt-1 m-0" style={{ color: "var(--orchestr-warning)" }}>
            Needed before anything can call this workflow — it is how a caller knows what it&apos;s for.
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
            What callers send
          </label>
          <button
            onClick={() => setInputs([...inputs, { name: "", type: "string", description: "", required: false }])}
            className="flex items-center gap-1 text-[11px] bg-transparent border-none cursor-pointer p-0"
            style={{ color: "var(--orchestr-accent)" }}
            data-testid="tool-trigger-add-input"
          >
            <Plus size={11} /> Add
          </button>
        </div>

        {inputs.length === 0 ? (
          <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Nothing declared — callers may send anything, and this workflow reads it as{" "}
            <code>{"{{trigger.<field>}}"}</code>.
          </p>
        ) : (
          <div className="space-y-1.5">
            {inputs.map((row, i) => (
              <div
                key={i}
                className="rounded-md border p-1.5 space-y-1.5"
                style={{ borderColor: "var(--orchestr-line)" }}
              >
                <div className="flex items-center gap-1.5">
                  <input
                    value={row.name}
                    onChange={(e) => patchInput(i, { name: e.target.value })}
                    placeholder="field name"
                    aria-label={`Input ${i + 1} name`}
                    className="flex-1 min-w-0 rounded px-2 py-1 text-[12px] outline-none font-mono"
                    style={fieldStyle}
                  />
                  <select
                    value={row.type}
                    onChange={(e) => patchInput(i, { type: e.target.value as ToolInputRow["type"] })}
                    aria-label={`Input ${i + 1} type`}
                    className="rounded px-1.5 py-1 text-[12px] outline-none"
                    style={fieldStyle}
                  >
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Yes / no</option>
                    <option value="object">Object</option>
                  </select>
                  <button
                    onClick={() => setInputs(inputs.filter((_, j) => j !== i))}
                    aria-label={`Remove input ${i + 1}`}
                    className="bg-transparent border-none cursor-pointer p-1 shrink-0"
                    style={{ color: "var(--orchestr-ink-subtle)" }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <input
                  value={row.description}
                  onChange={(e) => patchInput(i, { description: e.target.value })}
                  placeholder="what this field is for"
                  aria-label={`Input ${i + 1} description`}
                  className="w-full rounded px-2 py-1 text-[12px] outline-none"
                  style={fieldStyle}
                />
                <label className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
                  <input
                    type="checkbox"
                    checked={row.required}
                    onChange={(e) => patchInput(i, { required: e.target.checked })}
                  />
                  Required
                </label>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleTriggerConfig({
  params,
  setParams,
}: {
  params: Record<string, unknown>;
  /** Replaces the schedule's own keys atomically (mode switches drop the other mode's params). */
  setParams: (patch: {
    interval_minutes?: number;
    cron?: string;
    timezone?: string;
  }) => void;
}) {
  const cronValue = typeof params.cron === "string" ? params.cron : "";
  // Keyed on the `cron` KEY's presence, so clearing the text mid-edit can't flip the panel.
  const mode: "interval" | "cron" = params.cron !== undefined ? "cron" : "interval";
  const intervalMinutes = Number(params.interval_minutes ?? 15);
  // Display must mirror what RUNS: an absent timezone means the engine fires in UTC, so show UTC
  // rather than the browser zone (which is only the default committed on switching into cron mode).
  const timezone = typeof params.timezone === "string" && params.timezone ? params.timezone : "UTC";
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  // The other mode's last values, remembered in the handler (never during render).
  const [remembered, setRemembered] = useState<{ interval: number; cron: string }>({
    interval: 15,
    cron: "",
  });

  const zones = useMemo(() => timezoneChoices(), []);
  const malformed = cronLooksMalformed(cronValue);

  return (
    <div className="space-y-2" data-testid="schedule-config">
      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Repeats
        </label>
        <select
          value={mode}
          onChange={(e) => {
            if (e.target.value === "cron") {
              setRemembered((r) => ({ ...r, interval: intervalMinutes }));
              setParams({ cron: remembered.cron, timezone: browserZone });
            } else {
              setRemembered((r) => ({ ...r, cron: cronValue }));
              setParams({ interval_minutes: Math.max(1, remembered.interval || 15) });
            }
          }}
          aria-label="Schedule mode"
          className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
          style={{
            background: "var(--orchestr-surface-raised)",
            border: "1px solid var(--orchestr-line-strong)",
            color: "var(--orchestr-ink)",
          }}
          data-testid="schedule-mode-select"
        >
          <option value="interval">Every N minutes</option>
          <option value="cron">On a cron schedule</option>
        </select>
      </div>

      {mode === "interval" ? (
        <div>
          <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
            Run every (minutes)
          </label>
          <input
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(e) =>
              setParams({ interval_minutes: Math.max(1, Number(e.target.value) || 1) })
            }
            className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
            style={{
              background: "var(--orchestr-surface-raised)",
              border: "1px solid var(--orchestr-line-strong)",
              color: "var(--orchestr-ink)",
            }}
          />
        </div>
      ) : (
        <>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Cron expression
            </label>
            <input
              type="text"
              value={cronValue}
              onChange={(e) => setParams({ cron: e.target.value, timezone })}
              placeholder="0 9 * * 1-5"
              aria-label="Cron expression"
              className="w-full rounded-md px-2 py-1.5 text-[12px] font-mono outline-none"
              style={{
                background: "var(--orchestr-surface-raised)",
                border: `1px solid ${malformed ? "var(--orchestr-danger)" : "var(--orchestr-line-strong)"}`,
                color: "var(--orchestr-ink)",
              }}
              data-testid="schedule-cron-input"
            />
            <p
              className="text-[10px] m-0 mt-1 leading-snug"
              style={{ color: malformed ? "var(--orchestr-warning)" : "var(--orchestr-ink-subtle)" }}
            >
              {malformed
                ? "A cron has 5 fields: minute hour day-of-month month day-of-week."
                : (
                    <>
                      5 fields: minute hour day-of-month month day-of-week —{" "}
                      <span className="font-mono">0 9 * * 1-5</span>{" "}is weekdays at 09:00.
                    </>
                  )}
            </p>
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setParams({ cron: cronValue, timezone: e.target.value })}
              aria-label="Timezone"
              className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
              style={{
                background: "var(--orchestr-surface-raised)",
                border: "1px solid var(--orchestr-line-strong)",
                color: "var(--orchestr-ink)",
              }}
              data-testid="schedule-timezone-select"
            >
              {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
              The cron&apos;s wall-clock times hold in this zone across DST shifts.
            </p>
          </div>
        </>
      )}

      <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Fires on this schedule once a version with this trigger is promoted live.
      </p>
    </div>
  );
}

/**
 * Props + connection for an app/polling trigger, driven by its catalog schema through the same
 * control family actions get. An activation RUNS AS production's slot (there is no pool fallback),
 * so that is what's shown; with no slot, a single matching account only powers the pickers.
 */
function AppTriggerConfig({
  entry,
  params,
  setParam,
}: {
  entry: TriggerCatalogEntry | null;
  params: Record<string, unknown>;
  setParam: (key: string, value: unknown) => void;
}) {
  const needsConnection = entry?.auth === "connection";
  const app = entry?.type.includes(".") ? entry.type.split(".")[0] : undefined;
  // Production's slot for this app, plus a single-match fallback that can at least power the pickers.
  const [slot, setSlot] = useState<EnvironmentSlot | null | undefined>(undefined); // undefined = loading
  const [fallbackConn, setFallbackConn] = useState<Connection | null>(null);
  useEffect(() => {
    if (!needsConnection || !app) return;
    let cancelled = false;
    void (async () => {
      let found: EnvironmentSlot | null = null;
      try {
        const { environments } = await listEnvironments();
        found = environments.find((e) => e.is_prod)?.slots.find((s) => s.app === app) ?? null;
      } catch {
        found = null; // env list unavailable — behave as "no slot known"
      }
      if (cancelled) return;
      setSlot(found);
      if (found) return;
      try {
        const { connections } = await api.listConnections();
        const strict = matchingConnections(activeConnections(connections), app);
        if (!cancelled && strict.length === 1) setFallbackConn(strict[0]);
      } catch {
        // No fallback: the pickers degrade to text and the hint explains why.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsConnection, app]);
  const pickerConnectionId = slot?.connection_id ?? fallbackConn?.id;

  if (!entry) {
    return (
      <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
        This trigger is set — it fires once a version carrying it is promoted live.
      </p>
    );
  }
  const fields = Object.entries(entry.parameters ?? {});
  return (
    <div className="space-y-2">
      {entry.description && (
        <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {entry.description}
        </p>
      )}
      {needsConnection &&
        (slot ? (
          <p
            className="text-[10.5px] m-0 rounded-md px-2 py-1.5"
            style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
            data-testid="trigger-slot-connection"
          >
            Runs as <span style={{ color: "var(--orchestr-ink)" }}>{slot.account_label}</span> — production&apos;s{" "}
            {appDisplayName(app ?? "")}{" "}slot. Change it under{" "}
            <Link href="/integrations" target="_blank" className="underline">
              Integrations
            </Link>
            .
          </p>
        ) : slot === null ? (
          <p
            className="text-[10.5px] m-0 rounded-md px-2 py-1.5 flex items-start gap-1"
            style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-warning)" }}
            data-testid="trigger-slot-missing"
          >
            <AlertTriangle size={11} className="shrink-0 mt-[1px]" />
            <span>
              No production slot for {appDisplayName(app ?? "")}
              {" yet — this trigger can't go live until one is assigned under "}
              <Link href="/integrations" target="_blank" className="underline" style={{ color: "inherit" }}>
                Integrations
              </Link>
              .
              {fallbackConn ? (
                <span style={{ color: "var(--orchestr-ink-muted)" }}>
                  {" "}
                  Pickers below use your {connectionLabel(fallbackConn)} account meanwhile.
                </span>
              ) : null}
            </span>
          </p>
        ) : null)}
      {fields.map(([key, spec]) => {
        const t = (spec?.type ?? "").toUpperCase();
        if (t === "MARKDOWN") {
          return spec?.description ? (
            <p
              key={key}
              className="text-[11px] m-0 p-2 rounded-lg leading-relaxed whitespace-pre-line"
              style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
            >
              {spec.description.replace(/\*\*/g, "").trim()}
            </p>
          ) : null;
        }
        const val = params[key];
        const fieldStyle = {
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          color: "var(--orchestr-ink)",
        };
        const isMulti = MULTI_KINDS.has(t);
        const staticOptions =
          Array.isArray(spec?.options) && spec.options.length > 0 ? toOptions(spec.options) : null;
        const plainText = (
          <input
            type="text"
            value={val === undefined || val === null ? "" : String(val)}
            onChange={(e) => setParam(key, e.target.value)}
            aria-label={key}
            className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
            style={fieldStyle}
          />
        );
        return (
          <div key={key}>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              {spec?.label ?? humanizeKey(key)}
              {spec?.required ? " *" : ""}
            </label>
            {t === "BOOLEAN" || t === "CHECKBOX" ? (
              <input
                type="checkbox"
                checked={Boolean(val)}
                onChange={(e) => setParam(key, e.target.checked)}
                aria-label={key}
              />
            ) : staticOptions ? (
              <SelectField
                options={staticOptions}
                value={val}
                multiple={isMulti}
                onChange={(v) => setParam(key, v)}
                ariaLabel={key}
              />
            ) : DROPDOWN_KINDS.has(t) ? (
              <DynamicOptionsField
                nodeType={entry.type}
                prop={key}
                value={val}
                connectionId={pickerConnectionId}
                multiple={isMulti}
                onChange={(v) => setParam(key, v)}
                ariaLabel={key}
                fallback={plainText}
                connectionHint={
                  needsConnection && !pickerConnectionId
                    ? `Assign a production slot for ${appDisplayName(app ?? "")} (or connect an account) to pick from a list instead of typing an id.`
                    : undefined
                }
              />
            ) : t === "NUMBER" || t === "INTEGER" ? (
              <input
                type="number"
                // Whole-unit spinner for an INTEGER; free step for a NUMBER.
                step={t === "INTEGER" ? 1 : undefined}
                value={val === undefined || val === null ? "" : Number(val)}
                onChange={(e) => setParam(key, e.target.value === "" ? undefined : Number(e.target.value))}
                aria-label={key}
                className="w-full rounded-md px-2 py-1.5 text-[12px] outline-none"
                style={fieldStyle}
              />
            ) : t === "ARRAY" || t === "OBJECT" || t === "JSON" ? (
              <JsonParamField
                key={`json:${entry.type}:${key}`}
                value={val}
                kind={t}
                items={spec?.items}
                onChange={(v) => setParam(key, v)}
                ariaLabel={key}
                background="var(--orchestr-surface-raised)"
                restBorder="var(--orchestr-line-strong)"
              />
            ) : (
              plainText
            )}
            {spec?.required && isFieldEmpty(val) && (
              <p className="text-[10px] m-0 mt-1" style={{ color: "var(--orchestr-warning)" }}>
                Required
              </p>
            )}
            {spec?.description && (
              <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {spec.description}
              </p>
            )}
          </div>
        );
      })}
      <p className="text-[10px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Fires once a version carrying this trigger is promoted live.
      </p>
    </div>
  );
}

/** One Switch case — the SAME `{left, op, right}` condition shape `orchestr:if` carries. */
interface SwitchCase {
  left: string;
  op: string;
  right: string;
}

/** Coerce a stored `cases` array to editable `{left, op, right}` rows (string fields, op default eq). */
function normalizeCases(raw: unknown): SwitchCase[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  return raw.map((c) => {
    const o = (c !== null && typeof c === "object" ? c : {}) as Record<string, unknown>;
    return { left: str(o.left), op: typeof o.op === "string" ? o.op : "eq", right: str(o.right) };
  });
}

const CASE_OP_SELECT_STYLE = {
  background: "var(--orchestr-field)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
} as const;

/**
 * Switch case-list editor: an ordered list of N routes plus a fixed default, reusing IF's left/op/
 * right controls. Case `i` is output `i` (handle `p{i}`), and add/remove must go through the store's
 * `addSwitchCase` / `removeSwitchCase` so the output wires get re-mapped with the cases.
 */
function SwitchCasesEditor({
  cases,
  onCasesChange,
  onAddCase,
  onRemoveCase,
  upstream,
  samples,
  onTriggerSample,
}: {
  cases: SwitchCase[];
  onCasesChange: (cases: SwitchCase[]) => void;
  onAddCase: () => void;
  onRemoveCase: (index: number) => void;
  upstream: UpstreamStep[];
  samples: Record<string, unknown>;
  onTriggerSample: (payload: unknown) => void;
}) {
  const setCase = (index: number, patch: Partial<SwitchCase>) =>
    onCasesChange(cases.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-2" data-testid="switch-cases-editor">
      <label className="block text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
        Cases
      </label>
      <p className="text-[10px] m-0 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Checked top to bottom — the flow leaves on the first case that matches, else on the default. Each
        case is one output on the node; wire it from the matching handle.
      </p>

      {cases.length === 0 && (
        <p className="text-[10px] m-0" style={{ color: "var(--orchestr-warning)" }}>
          Add at least one case to route on.
        </p>
      )}

      {cases.map((c, i) => {
        const noRight = opDropsRight(c.op);
        return (
          <div
            key={i}
            className="rounded-lg p-2 space-y-1.5"
            style={{ border: "1px solid var(--orchestr-line)", background: "var(--orchestr-field)" }}
            data-testid={`switch-case-${i}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                Case {i + 1}
                <span style={{ color: "var(--orchestr-ink-subtle)" }}> · output {i + 1}</span>
              </span>
              {/* Removable only past one case: the engine needs a non-empty list. */}
              {cases.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveCase(i)}
                  aria-label={`Remove case ${i + 1}`}
                  title={`Remove case ${i + 1}`}
                  className="bg-transparent border-none p-0 cursor-pointer"
                  style={{ color: "var(--orchestr-ink-subtle)" }}
                  data-testid={`switch-remove-case-${i}`}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>

            <div>
              <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {humanizeKey("left")}
              </label>
              <ReferenceTextInput
                value={c.left}
                onChange={(v) => setCase(i, { left: v })}
                ariaLabel={`Case ${i + 1} left`}
                upstream={upstream}
                samples={samples}
                onTriggerSample={onTriggerSample}
              />
            </div>

            <div>
              <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {humanizeKey("op")}
              </label>
              <select
                value={c.op}
                onChange={(e) => setCase(i, { op: e.target.value })}
                aria-label={`Case ${i + 1} operator`}
                className="w-full h-8 px-2 rounded-lg text-[12px] outline-none"
                style={CASE_OP_SELECT_STYLE}
              >
                {IF_OPS.map((op) => (
                  <option key={op} value={op}>
                    {opLabel(op)}
                  </option>
                ))}
              </select>
            </div>

            {/* The engine drops `right` for truthy/falsy; the stored value survives a switch back. */}
            {!noRight && (
              <div>
                <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  {humanizeKey("right")}
                </label>
                <ReferenceTextInput
                  value={c.right}
                  onChange={(v) => setCase(i, { right: v })}
                  ariaLabel={`Case ${i + 1} right`}
                  upstream={upstream}
                  samples={samples}
                  onTriggerSample={onTriggerSample}
                />
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAddCase}
        className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg text-[12px] cursor-pointer"
        style={{
          background: "var(--orchestr-accent-tint)",
          border: "1px solid var(--orchestr-line)",
          color: "var(--orchestr-ink)",
        }}
        data-testid="switch-add-case"
      >
        <Plus size={12} /> Add case
      </button>

      {/* Read-only row so the trailing handle reads as the default, not an orphan. */}
      <div
        className="rounded-lg p-2 flex flex-col gap-0.5"
        style={{ border: "1px dashed var(--orchestr-line)", background: "rgba(0,0,0,0.08)" }}
        data-testid="switch-default-row"
      >
        <span className="text-[10.5px] font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
          Default
          <span style={{ color: "var(--orchestr-ink-subtle)" }}> · output {cases.length + 1}</span>
        </span>
        <span className="text-[10px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Runs when no case matches — wire it from the last handle on the node.
        </span>
      </div>
    </div>
  );
}

/**
 * IF node editor: the same left/op/right condition block Switch cases and the Loop while-condition
 * use, plus the then/else routing legend. `right` hides for the unary ops but its value is kept.
 */
function IfEditor({
  left,
  op,
  right,
  onChange,
  upstream,
  samples,
  onTriggerSample,
}: {
  left: string;
  op: string;
  right: string;
  onChange: (patch: Partial<SwitchCase>) => void;
  upstream: UpstreamStep[];
  samples: Record<string, unknown>;
  onTriggerSample: (payload: unknown) => void;
}) {
  const noRight = opDropsRight(op);
  return (
    <div className="space-y-2" data-testid="if-editor">
      <div
        className="rounded-lg p-2 space-y-1.5"
        style={{ border: "1px solid var(--orchestr-line)", background: "var(--orchestr-field)" }}
      >
        <span className="text-[10.5px] font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
          If
        </span>
        <div>
          <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {humanizeKey("left")}
          </label>
          <ReferenceTextInput
            value={left}
            onChange={(v) => onChange({ left: v })}
            ariaLabel="Condition left"
            upstream={upstream}
            samples={samples}
            onTriggerSample={onTriggerSample}
          />
        </div>
        <div>
          <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {humanizeKey("op")}
          </label>
          <select
            value={op}
            onChange={(e) => onChange({ op: e.target.value })}
            aria-label="Condition operator"
            className="w-full h-8 px-2 rounded-lg text-[12px] outline-none"
            style={CASE_OP_SELECT_STYLE}
          >
            {IF_OPS.map((o) => (
              <option key={o} value={o}>
                {opLabel(o)}
              </option>
            ))}
          </select>
        </div>
        {!noRight && (
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {humanizeKey("right")}
            </label>
            <ReferenceTextInput
              value={right}
              onChange={(v) => onChange({ right: v })}
              ariaLabel="Condition right"
              upstream={upstream}
              samples={samples}
              onTriggerSample={onTriggerSample}
            />
          </div>
        )}
        {isFieldEmpty(left) && (
          <p className="text-[10px] m-0" style={{ color: "var(--orchestr-warning)" }}>
            Set the value this condition tests.
          </p>
        )}
      </div>

      {/* Routing legend; the wording must match the canvas handle names. */}
      <p
        className="text-[11px] m-0 p-2 rounded-lg leading-relaxed"
        style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
      >
        When the condition holds, the flow leaves on <strong>then</strong> (the first output); otherwise
        it leaves on <strong>else</strong> (the second). Wire each from its handle on the node.
      </p>
    </div>
  );
}

/**
 * The Code node's in-scope data map: every upstream step as the exact token the snippet reads it by
 * (`trigger` or `steps.<id>`), with its sampled paths. Click copies — an insert would fight the caret.
 */
function CodeUpstreamRefs({ upstream }: { upstream: UpstreamStep[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (upstream.length === 0) return null;
  const tokenFor = (s: UpstreamStep, path?: string): string =>
    (s.isTrigger ? "trigger" : `steps.${s.refKey}`) + (path ? `.${path}` : "");
  const copy = (token: string) => {
    void navigator.clipboard.writeText(token).then(() => {
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  const FIELD_CAP = 8;
  return (
    <div data-testid="code-upstream-refs">
      <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
        Data in scope
      </label>
      <div
        className="rounded-lg px-2 py-1.5 space-y-1"
        style={{ border: "1px solid var(--orchestr-line)", background: "var(--orchestr-field)" }}
      >
        {upstream.map((s) => {
          const fields = (s.fields ?? []).slice(0, FIELD_CAP);
          return (
            <div key={s.id} className="min-w-0">
              <button
                type="button"
                onClick={() => copy(tokenFor(s))}
                title={`Copy ${tokenFor(s)}`}
                className="max-w-full flex items-baseline gap-1.5 bg-transparent border-none p-0 cursor-pointer"
              >
                <span className="text-[10.5px] font-mono truncate" style={{ color: "var(--orchestr-ink)" }}>
                  {tokenFor(s)}
                </span>
                <span className="text-[9px] shrink-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  {copied === tokenFor(s) ? "copied" : s.isTrigger ? "the firing event" : s.name}
                </span>
              </button>
              {fields.length > 0 ? (
                <div className="pl-2 flex flex-wrap gap-x-2">
                  {fields.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => copy(tokenFor(s, f.path))}
                      title={`Copy ${tokenFor(s, f.path)} — ${f.preview}`}
                      className="bg-transparent border-none p-0 cursor-pointer text-[9.5px] font-mono"
                      style={{ color: copied === tokenFor(s, f.path) ? "var(--orchestr-ink)" : "var(--orchestr-ink-subtle)" }}
                    >
                      .{f.path}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="pl-2 text-[9px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  {s.isTrigger
                    ? "No sample yet — catch or paste one via a field's {} picker."
                    : "Test that step to list its fields."}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Click to copy a reference, then paste it into the snippet.
      </p>
    </div>
  );
}

function CodeNodeEditor({
  nodeId,
  language,
  code,
  onLanguageChange,
  onCodeChange,
  upstream,
}: {
  nodeId: string;
  language: "js" | "ts";
  code: string;
  onLanguageChange: (language: "js" | "ts") => void;
  onCodeChange: (code: string) => void;
  upstream: UpstreamStep[];
}) {
  return (
    <div className="space-y-2" data-testid="code-node-editor">
      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Language
        </label>
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value === "ts" ? "ts" : "js")}
          aria-label="Snippet language"
          className="w-full h-8 px-2 rounded-lg text-[12px] outline-none"
          style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
          data-testid="code-language-select"
        >
          {CODE_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value} style={OPTION_STYLE}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <CodeUpstreamRefs upstream={upstream} />

      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Code *
        </label>
        <CodeMirrorEditor value={code} language={language} onChange={onCodeChange} ariaLabel="Code snippet" />
        {isFieldEmpty(code) && (
          <p className="text-[10px] m-0 mt-1" style={{ color: "var(--orchestr-warning)" }}>
            Required
          </p>
        )}
      </div>

      <p
        className="text-[11px] m-0 p-2 rounded-lg leading-relaxed"
        style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
      >
        Write an (async) function body. Read an earlier step as{" "}
        <span className="font-mono">steps.&lt;stepId&gt;.body.&lt;field&gt;</span>{" "}and the firing event as{" "}
        <span className="font-mono">trigger</span>; <span className="font-mono">await</span> is allowed.{" "}
        <span className="font-mono">return</span>{" "}a value — it becomes this step&apos;s output, read
        downstream as <span className="font-mono">{`{{${nodeId}.path}}`}</span>.
      </p>
    </div>
  );
}

/** Coerce a stored loop `condition` to an editable `{left, op, right}` (op default eq). */
function normalizeCondition(raw: unknown): SwitchCase {
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  const o = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { left: str(o.left), op: typeof o.op === "string" ? o.op : "eq", right: str(o.right) };
}

/**
 * Loop node editor (ADR 0029): `items` iterates a collection, `while` repeats do-while a condition
 * holds under a REQUIRED positive-integer `max_iterations`. Both modes stay two-port on the canvas.
 */
function LoopEditor({
  mode,
  items,
  itemVar,
  condition,
  maxIterations,
  onModeChange,
  onItemsChange,
  onItemVarChange,
  onConditionChange,
  onMaxIterationsChange,
  upstream,
  samples,
  onTriggerSample,
}: {
  mode: "items" | "while";
  items: string;
  itemVar: string;
  condition: SwitchCase;
  maxIterations: unknown;
  onModeChange: (mode: "items" | "while") => void;
  onItemsChange: (value: string) => void;
  onItemVarChange: (value: string) => void;
  onConditionChange: (condition: SwitchCase) => void;
  onMaxIterationsChange: (value: number | "") => void;
  upstream: UpstreamStep[];
  samples: Record<string, unknown>;
  onTriggerSample: (payload: unknown) => void;
}) {
  // The engine drops `right` for truthy/falsy, exactly as in the IF/Switch editors.
  const noRight = opDropsRight(condition.op);
  // The cap is the infinite-loop guard; the service rejects anything that isn't a whole number ≥ 1.
  const capInvalid = !(
    typeof maxIterations === "number" && Number.isInteger(maxIterations) && maxIterations >= 1
  );

  return (
    <div className="space-y-2" data-testid="loop-editor">
      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Mode
        </label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value === "while" ? "while" : "items")}
          aria-label="Loop mode"
          className={FIELD_CLASS}
          style={FIELD_STYLE}
          data-testid="loop-mode-select"
        >
          <option value="items" style={OPTION_STYLE}>
            Over items
          </option>
          <option value="while" style={OPTION_STYLE}>
            While condition
          </option>
        </select>
        <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {mode === "items"
            ? "Runs the body once per element of a collection."
            : "Repeats the body while a condition holds — always at least once."}
        </p>
      </div>

      {mode === "items" ? (
        <>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Items *
            </label>
            <ReferenceTextInput
              value={items}
              onChange={onItemsChange}
              ariaLabel="items"
              upstream={upstream}
              samples={samples}
              onTriggerSample={onTriggerSample}
            />
            {isFieldEmpty(items) && (
              <p className="text-[10px] m-0 mt-1" style={{ color: "var(--orchestr-warning)" }}>
                Required
              </p>
            )}
            <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
              An expression resolving to an array, e.g. <span className="font-mono">{`{{fetch_rows.rows}}`}</span>.
            </p>
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Item variable
            </label>
            {/* A bare identifier, not an expression, so no data-picker or value preview. */}
            <input
              type="text"
              value={itemVar}
              onChange={(e) => onItemVarChange(e.target.value)}
              placeholder="item"
              aria-label="item_var"
              className={FIELD_CLASS}
              style={FIELD_STYLE}
            />
            <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Name bound to each element in the body (default <span className="font-mono">item</span>; the
              index is <span className="font-mono">&lt;var&gt;Index</span>).
            </p>
          </div>
        </>
      ) : (
        <>
          <div
            className="rounded-lg p-2 space-y-1.5"
            style={{ border: "1px solid var(--orchestr-line)", background: "var(--orchestr-field)" }}
            data-testid="loop-condition"
          >
            <span className="text-[10.5px] font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
              Repeat while
            </span>
            <div>
              <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {humanizeKey("left")}
              </label>
              <ReferenceTextInput
                value={condition.left}
                onChange={(v) => onConditionChange({ ...condition, left: v })}
                ariaLabel="Condition left"
                upstream={upstream}
                samples={samples}
                onTriggerSample={onTriggerSample}
              />
            </div>
            <div>
              <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {humanizeKey("op")}
              </label>
              <select
                value={condition.op}
                onChange={(e) => onConditionChange({ ...condition, op: e.target.value })}
                aria-label="Condition operator"
                className="w-full h-8 px-2 rounded-lg text-[12px] outline-none"
                style={CASE_OP_SELECT_STYLE}
              >
                {IF_OPS.map((op) => (
                  <option key={op} value={op}>
                    {opLabel(op)}
                  </option>
                ))}
              </select>
            </div>
            {!noRight && (
              <div>
                <label className="block text-[10px] mb-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  {humanizeKey("right")}
                </label>
                <ReferenceTextInput
                  value={condition.right}
                  onChange={(v) => onConditionChange({ ...condition, right: v })}
                  ariaLabel="Condition right"
                  upstream={upstream}
                  samples={samples}
                  onTriggerSample={onTriggerSample}
                />
              </div>
            )}
            {isFieldEmpty(condition.left) && (
              <p className="text-[10px] m-0" style={{ color: "var(--orchestr-warning)" }}>
                Set the condition the loop repeats while true.
              </p>
            )}
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Max iterations *
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={typeof maxIterations === "number" ? maxIterations : ""}
              onChange={(e) => onMaxIterationsChange(e.target.value === "" ? "" : Number(e.target.value))}
              aria-label="max_iterations"
              className={FIELD_CLASS}
              style={{ ...FIELD_STYLE, border: `1px solid ${capInvalid ? "var(--orchestr-danger)" : "var(--orchestr-line)"}` }}
              data-testid="loop-max-iterations"
            />
            <p
              className="text-[10px] m-0 mt-1 leading-snug"
              style={{ color: capInvalid ? "var(--orchestr-warning)" : "var(--orchestr-ink-subtle)" }}
            >
              A whole number ≥ 1 — the hard cap on rounds that guards against an infinite loop.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * THE connection picker — never fork a second one. Purely presentational: the host owns loading,
 * auto-select, and the connectionId commit; `connections === null` means still loading.
 */
function ConnectionSelectField({
  connections,
  error,
  onRetry,
  appSlug,
  value,
  onChange,
  onConnected,
  helpText,
}: {
  connections: Connection[] | null;
  error: string | null;
  onRetry: () => void;
  appSlug: string | undefined;
  value: string;
  onChange: (id: string) => void;
  onConnected: (id: string) => void;
  helpText?: ReactNode;
}) {
  const shown = connections ? candidateConnections(connections, appSlug) : null;
  const strict = connections ? matchingConnections(connections, appSlug) : null;
  // No strict-matching account yet (fallback options don't count) → offer the one-click connect.
  const offerConnect = Boolean(appSlug) && strict !== null && strict.length === 0;
  return (
    <div data-testid="connection-field">
      {/* No "*": a connection is deliberately not gated by collectMissingRequired. */}
      <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
        Connection
      </label>
      {error ? (
        <InlineError message={error} onRetry={onRetry} />
      ) : shown === null ? (
        <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          <SaratiLoader size={14} /> Loading connections…
        </div>
      ) : (
        <>
          {offerConnect && appSlug && (
            <ConnectAppButton
              app={appSlug}
              appName={appDisplayName(appSlug)}
              onConnected={onConnected}
              size="sm"
              className="w-full"
              data-testid="connect-app-inline"
            />
          )}
          {shown.length === 0 ? (
            !offerConnect && (
              <div className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                No connections yet —{" "}
                <Link href="/integrations" target="_blank" className="underline" style={{ color: "var(--orchestr-ink)" }}>
                  connect one in Integrations
                </Link>
                , then pick it here.
              </div>
            )
          ) : (
            <select
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-label="Connection"
              className={`w-full h-8 px-2 rounded-lg text-[12px] outline-none${offerConnect ? " mt-1.5" : ""}`}
              style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
            >
              {value === "" && (
                <option value="">{offerConnect ? "Or pick an existing account…" : "Select a connection…"}</option>
              )}
              {shown.map((c) => (
                <option key={c.id} value={c.id} style={{ background: "var(--orchestr-surface-card)" }}>
                  {connectionLabel(c)}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
        {helpText ?? (
          <>
            The account this step runs as — needed before it can run. Manage accounts in{" "}
            <Link href="/integrations" target="_blank" className="underline">
              Integrations
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}

/**
 * AI Agent node editor (ADR 0045). Its params are the service compiler's contract: `system_prompt`,
 * a `{ provider, model }` object, and the `max_steps` cap. Tools are NOT configured here — they are
 * the nodes wired to its "tools" handle (`port_type:"tool"` edges, invariant #14).
 */
function AgentEditor({
  systemPrompt,
  model,
  maxSteps,
  input,
  connectionId,
  onSystemPromptChange,
  onModelChange,
  onMaxStepsChange,
  onInputChange,
  onConnectionChange,
  onConnectionAutoSelect,
  upstream,
  samples,
  onTriggerSample,
}: {
  systemPrompt: string;
  model: { provider?: string; model?: string } | undefined;
  maxSteps: unknown;
  input: string;
  connectionId: string;
  onSystemPromptChange: (value: string) => void;
  onModelChange: (value: { provider: string; model: string }) => void;
  onMaxStepsChange: (value: number | undefined) => void;
  onInputChange: (value: string) => void;
  onConnectionChange: (id: string) => void;
  onConnectionAutoSelect: (id: string) => void;
  upstream: UpstreamStep[];
  samples: Record<string, unknown>;
  onTriggerSample: (payload: unknown) => void;
}) {
  const selectedModel = model?.model || DEFAULT_AGENT_MODEL;
  // An unlisted current model stays selectable rather than snapping to a known option.
  const modelKnown = AGENT_MODEL_GROUPS.some((g) => g.models.includes(selectedModel));
  const stepsValue = typeof maxSteps === "number" ? maxSteps : "";
  // The model's optgroup doubles as the connection picker's app slug, so one account matches both.
  const provider =
    AGENT_MODEL_GROUPS.find((g) => g.models.includes(selectedModel))?.providerId ??
    model?.provider ??
    DEFAULT_AGENT_PROVIDER;

  // The model connection is an OPTIONAL override: an environment run resolves the provider from
  // that environment's slot, so an account is only needed for a by-hand Default/test run.
  const { connections, error: connectionsError, reload: reloadConnections } = useActiveConnections();

  // Exactly one account for this provider → pre-select it without dirtying the workflow.
  useEffect(() => {
    if (!connections || connectionId) return;
    const strict = matchingConnections(connections, provider);
    if (strict.length === 1) onConnectionAutoSelect(strict[0].id);
  }, [connections, provider, connectionId, onConnectionAutoSelect]);

  const handleConnected = (id: string) => {
    onConnectionChange(id);
    reloadConnections();
  };

  return (
    <div className="space-y-2" data-testid="agent-editor">
      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          System prompt
        </label>
        <textarea
          value={systemPrompt}
          rows={5}
          aria-label="System prompt"
          placeholder="You are a helpful assistant. Use the tools available to answer the user's request."
          onChange={(e) => onSystemPromptChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded-lg text-[12px] outline-none resize-y"
          style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
          data-testid="agent-system-prompt"
        />
        <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Instructions that steer the agent every turn — its role, how to use its tools, and when to stop.
        </p>
      </div>

      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Task / user message
        </label>
        <ReferenceTextInput
          value={input}
          onChange={onInputChange}
          ariaLabel="Task or user message"
          upstream={upstream}
          samples={samples}
          onTriggerSample={onTriggerSample}
        />
        <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
          The request the agent works on — usually a field from the trigger, e.g.{" "}
          <code>{"{{trigger.message}}"}</code>. Leave it empty to hand the agent the whole trigger payload.
        </p>
      </div>

      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Model
        </label>
        <select
          value={selectedModel}
          onChange={(e) => {
            const modelId = e.target.value;
            // The provider enum comes from the picked model's optgroup; an unlisted id keeps its own.
            const group = AGENT_MODEL_GROUPS.find((g) => g.models.includes(modelId));
            onModelChange({ provider: group?.providerId ?? model?.provider ?? DEFAULT_AGENT_PROVIDER, model: modelId });
          }}
          aria-label="Model"
          className={FIELD_CLASS}
          style={FIELD_STYLE}
          data-testid="agent-model-select"
        >
          {!modelKnown && <option value={selectedModel}>{selectedModel}</option>}
          {AGENT_MODEL_GROUPS.map((g) => (
            <optgroup key={g.provider} label={g.provider}>
              {g.models.map((m) => (
                <option key={m} value={m} style={OPTION_STYLE}>
                  {m}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Runs on the {provider} account — the environment&apos;s slot on a promoted run, or the account you pick below.
        </p>
      </div>

      <ConnectionSelectField
        connections={connections}
        error={connectionsError}
        onRetry={reloadConnections}
        appSlug={provider}
        value={connectionId}
        onChange={onConnectionChange}
        onConnected={handleConnected}
        helpText={
          <>
            Optional — a promoted run resolves the model from this environment&apos;s {provider}{" "}
            slot (the same kind of connection the LLM steps use). Pick an account to run the agent
            by hand on a Default/test run, or to pin a specific one. Manage accounts in{" "}
            <Link href="/integrations" target="_blank" className="underline">
              Integrations
            </Link>
            .
          </>
        }
      />

      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Max steps
        </label>
        <input
          type="number"
          min={1}
          max={AGENT_MAX_STEPS_CEILING}
          step={1}
          value={stepsValue}
          placeholder={String(DEFAULT_AGENT_MAX_STEPS)}
          onChange={(e) =>
            onMaxStepsChange(
              e.target.value === ""
                ? undefined
                : Math.min(AGENT_MAX_STEPS_CEILING, Math.max(1, Number(e.target.value) || 1)),
            )
          }
          aria-label="Max steps"
          className={FIELD_CLASS}
          style={FIELD_STYLE}
          data-testid="agent-max-steps"
        />
        <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
          The hard cap on model + tool rounds before the agent must answer (default{" "}
          {DEFAULT_AGENT_MAX_STEPS}, max {AGENT_MAX_STEPS_CEILING}).
        </p>
      </div>

      <p
        className="text-[11px] m-0 p-2 rounded-lg leading-relaxed"
        style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
      >
        Give the agent <strong>tools</strong> by wiring action nodes to the agent&apos;s{" "}
        <strong>tools</strong>{" "}handle (the AI-tinted socket at its base) — each becomes a tool it can call
        and return from. The agent&apos;s reply flows on from its normal output.
      </p>
    </div>
  );
}

/**
 * The scope an agent test seeds: ONLY the roots the agent's and its tool nodes' params reference,
 * plus a captured trigger sample. Never the whole samples map — that holds every node's output,
 * including this agent's own id, which collides with the plan's node id server-side.
 */
function agentTestScope(
  workflowJson: Record<string, unknown>,
  nodeId: string,
  samples: Record<string, unknown>,
): Record<string, unknown> {
  const nodes = (Array.isArray(workflowJson.nodes) ? workflowJson.nodes : []) as IrNodeShape[];
  const edges = (Array.isArray(workflowJson.edges) ? workflowJson.edges : []) as Array<{
    source_node_id?: string;
    target_node_id?: string;
    port_type?: string;
  }>;
  const toolIds = new Set(
    edges
      .filter((e) => e.source_node_id === nodeId && e.port_type === "tool")
      .map((e) => e.target_node_id),
  );
  const roots = new Set<string>();
  for (const n of nodes) {
    if (n.id === nodeId || toolIds.has(n.id)) {
      for (const root of referencedRoots(n.parameters ?? {})) roots.add(root);
    }
  }
  if (Object.prototype.hasOwnProperty.call(samples, "trigger")) roots.add("trigger");
  const scope: Record<string, unknown> = {};
  for (const root of roots) {
    if (root === nodeId) continue; // never the agent's own key — collides with the plan node
    scope[root] = Object.prototype.hasOwnProperty.call(samples, root) ? samples[root] : {};
  }
  return scope;
}

function AgentTestPanel({
  workflowId,
  workflowJson,
  nodeId,
  samples,
}: {
  workflowId: string | null;
  workflowJson: Record<string, unknown>;
  nodeId: string;
  samples: Record<string, unknown>;
}) {
  const [task, setTask] = useState("");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | { phase: "done"; answer: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const esRef = useRef<EventSource | null>(null);

  // Switching nodes remounts this panel, so the stream must close on unmount.
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const run = () => {
    if (state.phase === "running") return;
    setSteps([]);
    setState({ phase: "running" });
    const sessionId = newChatSessionId();
    // Subscribe first; only possible with a saved workflow, since the channel is workflow-scoped.
    if (workflowId) {
      const es = api.streamChatEvents(workflowId, api.AGENT_TEST_ENV, sessionId, (step) => {
        setSteps((s) => [...s, step]);
      });
      es.onerror = () => {
        es.close(); // stop browser auto-reconnect; the POST result still renders the trace
        if (esRef.current === es) esRef.current = null;
      };
      esRef.current = es;
    }
    void api
      .testAgentStep({
        workflow_ir: workflowJson,
        node_id: nodeId,
        ...(task.trim() ? { input: task.trim() } : {}),
        sample_scope: agentTestScope(workflowJson, nodeId, samples),
        ...(workflowId ? { workflow_id: workflowId, session_id: sessionId } : {}),
      })
      .then((res) => {
        const out = res.outputs?.[nodeId] as { text?: string; steps?: AgentStep[] } | undefined;
        // The recorded trace wins, so an unstreamed (unsaved-draft) run still shows every step.
        if (Array.isArray(out?.steps)) setSteps(out.steps);
        setState({ phase: "done", answer: typeof out?.text === "string" ? out.text : "" });
      })
      .catch((e) => {
        setState({ phase: "error", message: e instanceof Error ? e.message : "The agent test failed." });
      })
      .finally(() => {
        esRef.current?.close();
        esRef.current = null;
      });
  };

  return (
    <div className="pt-2.5 mt-1" style={{ borderTop: "1px solid var(--orchestr-line)" }} data-testid="agent-test-panel">
      <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
        Test this agent
      </label>
      <div className="flex items-center gap-1.5">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          placeholder="Task for this run — e.g. Summarize yesterday's signups"
          aria-label="Test task"
          className="flex-1 min-w-0 h-8 px-2 rounded-lg text-[12px] outline-none"
          style={FIELD_STYLE}
          data-testid="agent-test-task"
        />
        <button
          type="button"
          onClick={run}
          disabled={state.phase === "running"}
          className="shrink-0 h-8 px-2.5 flex items-center gap-1 rounded-lg text-[12px] font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            background: "var(--orchestr-accent-tint)",
            border: "1px solid var(--orchestr-line)",
            color: "var(--orchestr-ink)",
          }}
          data-testid="agent-test-run"
        >
          {state.phase === "running" ? <SaratiLoader size={13} /> : <Play size={12} />}
          Run
        </button>
      </div>
      <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Runs just this agent with the tools wired on the canvas — leave the task empty to use the
        node&apos;s own Task field{Object.prototype.hasOwnProperty.call(samples, "trigger") ? " against the captured trigger sample" : ""}.
      </p>
      {/* A test is a real effect: the agent's TOOLS execute. */}
      <p
        className="text-[10px] m-0 mt-1 leading-snug flex items-start gap-1"
        style={{ color: "var(--orchestr-warning)" }}
        data-testid="agent-test-real-effects"
      >
        <AlertTriangle size={11} className="shrink-0 mt-[1px]" />
        <span>The model call and every tool it picks run for real. {REAL_RUN_CONSEQUENCE}</span>
      </p>

      {(steps.length > 0 || state.phase === "running") && (
        <div className="mt-2">
          <AgentStepTrace steps={steps} streaming={state.phase === "running"} />
        </div>
      )}
      {state.phase === "done" && (
        <div className="mt-1.5">
          <div className="text-[10px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
            Answer
          </div>
          <p
            className="text-[11px] m-0 p-2 rounded-lg whitespace-pre-wrap break-words"
            style={{
              background: "var(--orchestr-field)",
              border: "1px solid var(--orchestr-line)",
              color: "var(--orchestr-ink)",
              maxHeight: 220,
              overflowY: "auto",
            }}
            data-testid="agent-test-answer"
          >
            {state.answer || "(the agent returned no text)"}
          </p>
        </div>
      )}
      {state.phase === "error" && (
        <p
          className="text-[10.5px] m-0 mt-2 p-2 rounded-lg leading-snug break-words"
          style={{
            background: "var(--orchestr-field)",
            border: "1px solid var(--orchestr-danger)",
            color: "var(--orchestr-danger)",
          }}
          data-testid="agent-test-error"
        >
          {state.message}
        </p>
      )}
    </div>
  );
}

/**
 * Call-workflow node editor (ADR 0045 §3): a picker committing `workflow_id`, excluding the current
 * workflow because a workflow can't call itself. Its tool name/description live in the shared
 * "Used as an agent tool" fields, never redefined here.
 */
/**
 * Pick the workflow this step runs, and fill what it declared it needs (ADR 0062). The list is the
 * CALLABLE ones only — a workflow that never declared itself would be refused at run time, so
 * offering it here would just move the discovery later.
 */
function CallWorkflowEditor({
  value,
  input,
  currentWorkflowId,
  isAgentTool,
  onChange,
  onInputChange,
}: {
  value: string;
  input: Record<string, unknown>;
  currentWorkflowId: string | null;
  /** Wired to an agent's tools handle — the MODEL produces the input then, so the fields are moot. */
  isAgentTool: boolean;
  onChange: (workflowId: string) => void;
  onInputChange: (input: Record<string, unknown>) => void;
}) {
  const [callable, setCallable] = useState<CallableWorkflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .listCallableWorkflows()
      .then(({ workflows: rows }) => {
        if (cancelled) return;
        setCallable(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your workflows");
      });
    return () => {
      cancelled = true;
    };
  }, [epoch]);

  // Every callable workflow EXCEPT this one — a workflow can't call itself.
  const options = (callable ?? []).filter((w) => w.workflow_id !== currentWorkflowId);
  // An unknown current id stays selectable, shown raw, rather than being silently dropped.
  const known = value === "" || options.some((w) => w.workflow_id === value);
  const target = options.find((w) => w.workflow_id === value) ?? null;

  return (
    <div data-testid="call-workflow-editor" className="space-y-2">
      <div>
        <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
          Workflow to run
        </label>
        <select
          value={value}
          aria-label="Workflow to run"
          onChange={(e) => onChange(e.target.value)}
          className={FIELD_CLASS}
          style={FIELD_STYLE}
          disabled={callable === null}
          data-testid="call-workflow-picker"
        >
          <option value="">{callable === null ? "Loading workflows…" : "Select a workflow…"}</option>
          {!known && value !== "" && <option value={value}>{value}</option>}
          {options.map((w) => (
            <option key={w.workflow_id} value={w.workflow_id} style={OPTION_STYLE}>
              {w.name}
            </option>
          ))}
        </select>
        {target?.description && (
          <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {target.description}
          </p>
        )}
        {!known && value !== "" && callable !== null && (
          <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-warning)" }}>
            This workflow isn&apos;t callable: its live version needs a &quot;Called by another
            workflow&quot; trigger with a name and description, published to production.
          </p>
        )}
      </div>

      {error && (
        <InlineError
          message={error}
          onRetry={() => {
            setError(null);
            setEpoch((n) => n + 1);
          }}
        />
      )}
      {!error && callable !== null && options.length === 0 && (
        <p className="text-[10px] m-0 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
          No workflow has declared itself callable yet. Open one, set its trigger to &quot;Called by
          another workflow&quot;, then publish it.
        </p>
      )}

      {/* What the target receives — a field per input it declared. */}
      {target && !isAgentTool && (
        <div className="space-y-1.5">
          <label className="block text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
            What to send it
          </label>
          {target.inputs.length === 0 ? (
            <p className="text-[10px] m-0 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
              It declares no fields, so it runs on whatever you send — or on nothing.
            </p>
          ) : (
            target.inputs.map((field) => (
              <div key={field.name}>
                <label
                  className="block text-[11px] mb-1"
                  style={{ color: "var(--orchestr-ink-muted)" }}
                  htmlFor={`call-input-${field.name}`}
                >
                  {field.name}
                  {field.required && <span style={{ color: "var(--orchestr-danger)" }}> *</span>}
                </label>
                <input
                  id={`call-input-${field.name}`}
                  value={typeof input[field.name] === "string" ? (input[field.name] as string) : ""}
                  onChange={(e) => onInputChange({ ...input, [field.name]: e.target.value })}
                  placeholder={field.description || `{{trigger.${field.name}}}`}
                  className={FIELD_CLASS}
                  style={FIELD_STYLE}
                  data-testid={`call-input-${field.name}`}
                />
                {field.description && (
                  <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    {field.description}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <p className="text-[10px] m-0 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
        {isAgentTool
          ? "The agent decides when to run this workflow and fills its input itself."
          : "Runs this workflow's live version in the current environment, on your accounts, and its last step's output becomes this step's result."}
      </p>
    </div>
  );
}

export default function IrNodeInspector({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const updateIrNode = useWorkflow((s) => s.updateIrNode);
  const addSwitchCase = useWorkflow((s) => s.addSwitchCase);
  const removeSwitchCase = useWorkflow((s) => s.removeSwitchCase);
  const setLoopMode = useWorkflow((s) => s.setLoopMode);
  const deleteWorkflowNode = useWorkflow((s) => s.deleteWorkflowNode);
  const workflowId = useWorkflow((s) => s.workflowId);

  const node = ((workflowJson?.nodes as IrNodeShape[]) ?? []).find((n) => n.id === nodeId) ?? null;

  // Scopes live samples to THIS document, so a prior workflow's samples can't leak in.
  const scopeKey =
    workflowId ?? (typeof workflowJson?.name === "string" && workflowJson.name ? workflowJson.name : "draft");
  const samples = useStepSamples((s) => (s.scopeKey === scopeKey ? s.samples : EMPTY_SAMPLES));
  const setSample = useStepSamples((s) => s.setSample);
  const clearSample = useStepSamples((s) => s.clearSample);
  const seedBackground = useStepSamples((s) => s.seedBackground);
  const pinStep = useStepSamples((s) => s.pinStep);
  const unpinStep = useStepSamples((s) => s.unpinStep);
  // Pinned (ADR 0021) means a Run replays this step's captured output instead of executing it.
  const isPinned = useStepSamples((s) => (s.scopeKey === scopeKey ? Boolean(s.pinned[nodeId]) : false));

  // Seeds the picker from the last real run as background data, so this session's samples win.
  // Cached briefly per workflow, because the inspector remounts on every node click.
  useEffect(() => {
    if (!workflowId) return;
    const at = runSamplesFetchedAt.get(workflowId);
    if (at !== undefined && Date.now() - at < 30_000) return;
    // Deliberately uncancelled: the store is global, so a late seed is what the next open wants,
    // and a cancelled-flag here drops every seed under React's dev double-mount.
    api
      .getRunSamples(workflowId)
      .then(({ sample }) => {
        runSamplesFetchedAt.set(workflowId, Date.now());
        if (sample?.outputs) seedBackground(scopeKey, sample.outputs);
      })
      .catch(() => {
        // No samples is a normal state, never an error surface.
      });
  }, [workflowId, scopeKey, seedBackground]);

  // The data-picker's reference targets, augmented with field-level picks once a sample exists.
  const upstream = useMemo(() => {
    const base = workflowJson ? upstreamStepsFor(workflowJson, nodeId) : [];
    return base.map((s) => {
      const sample = samples[s.refKey];
      return sample !== undefined ? { ...s, fields: sampleFields(sample) } : s;
    });
  }, [workflowJson, nodeId, samples]);
  const [schema, setSchema] = useState<NodeTypeEntry | null>(null);
  // A null `schema` can't distinguish "not in the catalog" from "not fetched yet", so the
  // broken-node banner must wait on this or every legit action flashes broken while it loads.
  const [schemaResolved, setSchemaResolved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Triggers configure through TriggerTypeConfig; running this too would render both surfaces.
    if (!node || nodeIsTrigger(node)) return;
    // No synchronous reset needed: the parent keys this component by nodeId, so another node
    // remounts with `schemaResolved` back at false.
    void catalogEntryFor(node.node_type!).then((entry) => {
      if (!cancelled) {
        setSchema(entry);
        setSchemaResolved(true);
      }
    });
    return () => {
      cancelled = true;
    };
    // node_type is the only input; metadata.trigger is stable per node type here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.node_type]);

  // Per-field expression mode: a typed widget swaps for the expression input so it can carry
  // `{{…}}`. Unset falls back to "the stored value already looks like an expression".
  const [fxKeys, setFxKeys] = useState<Record<string, boolean>>({});

  // Optional-and-empty params start collapsed; one toggle reveals them.
  const [showOptional, setShowOptional] = useState(false);
  // Params edited this session: an emptied optional field must stay on screen, not vanish.
  const [touchedKeys, setTouchedKeys] = useState<Set<string>>(() => new Set());

  // `auth: "connection"` means the run needs a `connectionId` param, so offer the account select.
  const needsConnection = schema?.auth === "connection";
  const { connections, error: connectionsError, reload: reloadConnections } = useActiveConnections(needsConnection);

  // The step's app slug. Auto-select must only ever act on STRICT matches, never the
  // fall-back-to-everything list.
  const appSlug = node?.node_type?.includes(".") ? node.node_type.split(".")[0] : undefined;
  const strictMatches = useMemo(
    () => (connections ? matchingConnections(connections, appSlug) : null),
    [connections, appSlug],
  );

  // Exactly one connection for this app → pre-select it (zero decisions on the
  // happy path). Reads the live node from the store so a stale render can't
  // clobber parameters someone else just wrote.
  useEffect(() => {
    if (!strictMatches || strictMatches.length !== 1) return;
    const doc = useWorkflow.getState().workflowJson as { nodes?: IrNodeShape[] } | null;
    const live = doc?.nodes?.find((n) => n.id === nodeId);
    if (!live) return;
    const p = live.parameters ?? {};
    if (typeof p.connectionId === "string" && p.connectionId !== "") return;
    // markDirty: false — auto-select is a default, not a user edit, so opening a node can't dirty it.
    updateIrNode(nodeId, { parameters: { ...p, connectionId: strictMatches[0].id } }, { markDirty: false });
  }, [nodeId, strictMatches, updateIrNode]);

  // "Test this step" runs this one node for real; `missing` names referenced steps with no sample.
  const [test, setTest] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | { phase: "done"; input: Record<string, unknown>; output: unknown; missing: string[]; warnings: string[] }
    | { phase: "error"; message: string; input: Record<string, unknown>; missing: string[] }
  >({ phase: "idle" });
  // Which side of the data panel is showing (Input | Output).
  const [dataTab, setDataTab] = useState<"input" | "output">("output");

  if (!node) return null;
  const params = node.parameters ?? {};
  // Each of these node types owns its own params through a dedicated editor below, so the generic
  // field form must exclude them (see the filter under `keys`).
  const isSwitch = node.node_type === "orchestr:switch";
  const isCode = node.node_type === "orchestr:code";
  const isLoop = node.node_type === "orchestr:loop";
  const isAgent = node.node_type === "orchestr:agent";
  const isIf = node.node_type === "orchestr:if";
  const isCallWorkflow = node.node_type === "orchestr:call_workflow";
  // Schema keys first (declared order), then extra keys the document carries. A trigger's params
  // belong entirely to TriggerTypeConfig, so the generic form renders none of them.
  const keys = nodeIsTrigger(node)
    ? []
    : [
        ...Object.keys(schema?.parameters ?? {}),
        ...Object.keys(params).filter((k) => !(k in (schema?.parameters ?? {}))),
        // `connectionId`, `onError` and `retry` are reserved orchestration keys with own controls.
      ].filter(
        (k) =>
          !(needsConnection && k === "connectionId") &&
          k !== "onError" &&
          k !== "retry" &&
          k !== "tool_name" &&
          k !== "tool_description" &&
          !(isSwitch && k === "cases") &&
          !(isCode && (k === "language" || k === "code")) &&
          !(isLoop && LOOP_PARAM_KEYS.has(k)) &&
          !(isAgent && AGENT_PARAM_KEYS.has(k)) &&
          !(isIf && (k === "left" || k === "op" || k === "right")) &&
          // Both belong to CallWorkflowEditor: `input` renders there as a field per declared
          // input, so leaving it here too would show the same value twice, once as raw JSON.
          !(isCallWorkflow && (k === "workflow_id" || k === "input")),
      );

  // The same per-field rule the inline "Required" markers use, feeding the Test-button gate.
  const requiredEmptyKeys = keys.filter((k) => {
    const spec = schema?.parameters?.[k];
    return spec?.required && isFieldEmpty(params[k]);
  });
  const hasRequiredEmpty = requiredEmptyKeys.length > 0;

  // A single-step test hits the provider NOW with these exact params — there is no environment-slot
  // resolution — so an empty connectionId can only fail. The deploy gate deliberately doesn't block.
  const connectionMissing =
    needsConnection && !(typeof params.connectionId === "string" && params.connectionId !== "");

  const commit = (key: string, value: unknown) => {
    // Touched params stay visible for the session even if the edit emptied them.
    setTouchedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    updateIrNode(node.id, { parameters: { ...params, [key]: value } });
  };

  const codeLanguage: "js" | "ts" = params.language === "ts" ? "ts" : "js";
  const codeValue = typeof params.code === "string" ? params.code : "";

  // Retry policy (ADR 0020); maxAttempts ≤ 1 clears the key, and the compiler clamps on save.
  const retryCfg = (params.retry ?? null) as { maxAttempts?: number; backoffMs?: number } | null;
  const retryAttempts = typeof retryCfg?.maxAttempts === "number" ? retryCfg.maxAttempts : 1;
  const retryBackoffMs = typeof retryCfg?.backoffMs === "number" ? retryCfg.backoffMs : 1000;
  const setRetry = (attempts: number, backoffMs: number) => {
    const next = { ...params };
    if (attempts > 1) next.retry = { maxAttempts: Math.min(10, attempts), backoffMs: Math.max(0, backoffMs) };
    else delete next.retry;
    updateIrNode(node.id, { parameters: next });
  };

  // An error branch (ADR 0020) WINS over "On failure", so the select below is moot when one exists.
  const hasErrorBranch = (
    (workflowJson?.edges as Array<{ source_node_id?: string; port_type?: string }> | undefined) ?? []
  ).some((e) => e.source_node_id === node.id && e.port_type === "error");

  // Wired to an agent's tools handle (invariant #14), so its model-facing name/description matter.
  const isAgentTool = (
    (workflowJson?.edges as Array<{ target_node_id?: string; port_type?: string }> | undefined) ?? []
  ).some((e) => e.target_node_id === node.id && e.port_type === "tool");
  // A display hint mirroring the compiler's buildAgentTool defaults; execution never reads this.
  const defaultToolName = (
    node.node_type === "orchestr:call_workflow" ? node.name || "workflow" : (node.node_type ?? "")
  )
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);

  // In-flow connect succeeded: attach the new account to this step and refresh
  // the list so the select shows it by name.
  const handleConnected = (connectionId: string) => {
    commit("connectionId", connectionId);
    reloadConnections();
  };

  const nodeType = node.node_type ?? "";
  // Broken = the lookup RESOLVED to no entry and the type isn't native — a removed or renamed action.
  // Must stay the same predicate the deploy gate uses, so the banner and the gate agree.
  const isBroken =
    schemaResolved && schema === null && !isNativeOrTriggerType(node.node_type, node.metadata);
  const canTest =
    nodeType !== "" &&
    !nodeIsTrigger(node) &&
    nodeType !== "orchestr:if" &&
    nodeType !== "orchestr:switch" &&
    nodeType !== "orchestr:wait_for_event" &&
    nodeType !== "orchestr:loop" &&
    // The agent's tools come from canvas edges, which an isolated single-node test can't carry.
    nodeType !== "orchestr:agent" &&
    // Call-workflow runs a whole sub-workflow in an env, which a single-node test can't stand up.
    nodeType !== "orchestr:call_workflow";

  // Loop driver (ADR 0029); existing loops carry no `mode`, so `items` is the default.
  const loopMode: "items" | "while" = params.mode === "while" ? "while" : "items";
  // Drives the {{item}}/{{itemIndex}} guidance, so a customized item_var shows matching refs.
  const loopItemVar =
    typeof params.item_var === "string" && params.item_var.trim() ? params.item_var.trim() : "item";

  const runTest = async () => {
    setTest({ phase: "running" });
    // An unsampled referenced step is seeded empty so the resolver never throws, and reported.
    const scope: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const root of referencedRoots(params)) {
      if (root === node.id) continue;
      if (Object.prototype.hasOwnProperty.call(samples, root)) {
        scope[root] = samples[root];
      } else {
        scope[root] = {};
        missing.push(root);
      }
    }
    try {
      const res = await api.testStep(
        { id: node.id, node_type: nodeType, name: node.name, parameters: params },
        scope,
      );
      const output = res.outputs?.[node.id];
      setSample(scopeKey, node.id, output);
      // Non-fatal notes (a dropped input, a ref that resolved to nothing); the step still ran.
      const warnings = res.trace?.find((t) => t.nodeId === node.id)?.warnings ?? [];
      setDataTab("output");
      setTest({ phase: "done", input: scope, output, missing, warnings });
    } catch (e) {
      setTest({
        phase: "error",
        message: e instanceof Error ? e.message : "The test run failed.",
        input: scope,
        missing,
      });
    }
  };

  // Friendly labels for the "used empty values" nudge (step name, or raw id).
  const missingLabel = (refKey: string): string =>
    refKey === "trigger"
      ? "trigger payload"
      : (upstream.find((u) => u.refKey === refKey)?.name ?? refKey);

  // The default control, the dropdown's degrade path, and the fx-mode widget; objects render as JSON.
  const textInputFor = (key: string, multiline = false) => {
    const value = params[key];
    const str =
      typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
    return (
      <ReferenceTextInput
        value={str}
        onChange={(v) => commit(key, v)}
        ariaLabel={key}
        upstream={upstream}
        samples={samples}
        onTriggerSample={(payload) => setSample(scopeKey, "trigger", payload)}
        multiline={multiline}
      />
    );
  };

  // ONE decision for which control family a param renders as: the widget and the fx hatch both read it.
  type FieldKind = "select" | "dropdown" | "checkbox" | "number" | "json" | "longText" | "text";
  const fieldKindFor = (key: string): FieldKind => {
    const spec = schema?.parameters?.[key];
    // Two catalog dialects normalized once: SDK kind names (SHORT_TEXT, CHECKBOX…) and Composio's
    // uppercased JSON-schema types (INTEGER, BOOLEAN…), so neither falls through to a bare text box.
    const kind = (spec?.type ?? "").toUpperCase();
    const value = params[key];
    if (Array.isArray(spec?.options) && spec.options.length > 0) return "select";
    if (DROPDOWN_KINDS.has(kind) && node.node_type) return "dropdown";
    if (kind === "CHECKBOX" || kind === "BOOLEAN" || typeof value === "boolean") return "checkbox";
    if (kind === "NUMBER" || kind === "INTEGER" || typeof value === "number") return "number";
    if (LONG_TEXT_KINDS.has(kind)) return "longText";
    const structured = kind === "ARRAY" || kind === "JSON" || kind === "OBJECT";
    if (structured || (value !== null && value !== undefined && typeof value === "object")) return "json";
    return "text";
  };

  // The fx hatch exists only where the widget isn't already the expression input, and only once
  // there are earlier steps to reference.
  const FX_KINDS = new Set<FieldKind>(["select", "dropdown", "checkbox", "number", "json"]);
  const fxCapable = (key: string): boolean => upstream.length > 0 && FX_KINDS.has(fieldKindFor(key));
  const fxActive = (key: string): boolean => {
    if (!fxCapable(key)) return false;
    const value = params[key];
    return fxKeys[key] ?? (typeof value === "string" && value.includes("{{"));
  };
  const toggleFx = (key: string) => {
    const turningOn = !fxActive(key);
    if (!turningOn) {
      // Leaving fx: number/checkbox widgets can't show a string, so convert or clear. Selects and
      // the JSON textarea can render any value, so their stored value is left untouched.
      const value = params[key];
      const kind = fieldKindFor(key);
      if (typeof value === "string") {
        if (kind === "number") {
          const n = Number(value);
          commit(key, value.trim() !== "" && Number.isFinite(n) ? n : "");
        } else if (kind === "checkbox") {
          commit(key, value.trim() === "true");
        }
      }
    }
    setFxKeys((m) => ({ ...m, [key]: turningOn }));
  };

  const fieldFor = (key: string) => {
    const spec = schema?.parameters?.[key];
    const kind = (spec?.type ?? "").toUpperCase();
    const value = params[key];
    const family = fieldKindFor(key);

    // In expression mode the field carries a `{{…}}` mapping, so the typed widget can't render it.
    if (fxActive(key)) return textInputFor(key);

    if (family === "longText") return textInputFor(key, true);

    const isMulti = MULTI_KINDS.has(kind);
    if (family === "select") {
      // Static enum choices are inlined in the catalog — render a select, no fetch.
      const staticOptions = toOptions(spec?.options ?? []);
      return (
        <SelectField
          options={staticOptions}
          value={value}
          multiple={isMulti}
          onChange={(v) => commit(key, v)}
          ariaLabel={key}
        />
      );
    }
    // No inlined options: load them live, falling back to the text field when that can't run.
    if (family === "dropdown" && node.node_type) {
      const connId =
        typeof params.connectionId === "string" && params.connectionId ? params.connectionId : undefined;
      return (
        <DynamicOptionsField
          nodeType={node.node_type}
          prop={key}
          value={value}
          connectionId={connId}
          multiple={isMulti}
          onChange={(v) => commit(key, v)}
          ariaLabel={key}
          fallback={textInputFor(key)}
          connectionHint={
            needsConnection && !connId
              ? "Select a connection above to pick from your account instead of typing an id."
              : undefined
          }
        />
      );
    }

    if (family === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => commit(key, e.target.checked)}
          aria-label={key}
        />
      );
    }
    if (family === "number") {
      const bounds = numericBounds(key, spec, appSlug);
      const rangeHint =
        bounds.min !== undefined && bounds.max !== undefined
          ? `Allowed range ${bounds.min}–${bounds.max}.`
          : bounds.max !== undefined
            ? `Must be ≤ ${bounds.max}.`
            : bounds.min !== undefined
              ? `Must be ≥ ${bounds.min}.`
              : null;
      return (
        <>
          <input
            type="number"
            min={bounds.min}
            max={bounds.max}
            // A declared INTEGER steps in whole units, so the spinner can't offer a fraction.
            step={bounds.step ?? (kind === "INTEGER" ? 1 : undefined)}
            // A numeric STRING in the IR renders rather than blanking, and self-heals on first edit.
            value={
              typeof value === "number"
                ? value
                : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
                  ? value
                  : ""
            }
            onChange={(e) => commit(key, e.target.value === "" ? "" : Number(e.target.value))}
            aria-label={key}
            className="w-full h-8 px-2 rounded-lg text-[12px] outline-none"
            style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
          />
          {rangeHint && (
            <p className="text-[10px] m-0 mt-1" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {rangeHint}
            </p>
          )}
        </>
      );
    }
    if (family === "json") {
      return (
        <JsonParamField
          key={`json:${node.id}:${key}`}
          value={value}
          kind={kind}
          items={spec?.items}
          onChange={(v) => commit(key, v)}
          ariaLabel={key}
        />
      );
    }
    return textInputFor(key);
  };

  /**
   * An optional param that is empty and untouched hides behind "Show optional"; anything required,
   * MARKDOWN, valued, in fx mode, or edited this session stays visible, so no field can vanish under
   * the cursor. Keys always render in schema order, never regrouped.
   */
  const isOptionalHidden = (key: string): boolean => {
    const spec = schema?.parameters?.[key];
    if (spec?.required || (spec?.type ?? "").toUpperCase() === "MARKDOWN") return false;
    if (touchedKeys.has(key)) return false;
    if (!isFieldEmpty(params[key]) || fxActive(key)) return false;
    return !showOptional;
  };
  const hiddenOptionalCount = keys.filter((key) => isOptionalHidden(key)).length;
  // How many shown fields would re-hide on collapse; the "Hide" affordance needs a non-zero count.
  const optionalHideableCount = showOptional
    ? keys.filter((key) => {
        const spec = schema?.parameters?.[key];
        if (spec?.required || (spec?.type ?? "").toUpperCase() === "MARKDOWN") return false;
        if (touchedKeys.has(key)) return false;
        return isFieldEmpty(params[key]) && !fxActive(key);
      }).length
    : 0;

  const renderParamField = (key: string) => {
    const spec = schema?.parameters?.[key];
    // MARKDOWN params carry guidance, not a value, so they render as help text and never an input.
    if ((spec?.type ?? "").toUpperCase() === "MARKDOWN") {
      if (!spec?.description) return null;
      return (
        <p
          key={key}
          className="text-[11px] m-0 p-2 rounded-lg leading-relaxed whitespace-pre-line"
          style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
        >
          {spec.description.replace(/\*\*/g, "").trim()}
        </p>
      );
    }
    const fx = fxActive(key);
    return (
      <div key={key}>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
            {spec?.label ?? humanizeKey(key)}
            {spec?.required ? " *" : ""}
          </label>
          {/* The fx hatch: swaps this typed field for the expression input. */}
          {fxCapable(key) && (
            <button
              type="button"
              onClick={() => toggleFx(key)}
              aria-label={fx ? `Use a fixed value for ${key}` : `Use an expression for ${key}`}
              title={fx ? "Back to a fixed value" : "Use an expression — insert data from an earlier step"}
              className="shrink-0 h-5 px-1 flex items-center gap-0.5 rounded cursor-pointer bg-transparent border-none text-[9px] font-medium"
              style={{ color: fx ? "var(--orchestr-ai)" : "var(--orchestr-ink-subtle)" }}
              data-testid={`fx-toggle-${key}`}
            >
              <Braces size={11} />
              fx
            </button>
          )}
        </div>
        {fieldFor(key)}
        {spec?.required && isFieldEmpty(params[key]) && (
          <p className="text-[10px] m-0 mt-1" style={{ color: "var(--orchestr-warning)" }}>
            Required
          </p>
        )}
        {spec?.description && (
          <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {spec.description}
          </p>
        )}
      </div>
    );
  };

  return (
    <div
      className="w-[300px] shrink-0 rounded-xl flex flex-col min-h-0"
      style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <div className="flex-1 min-w-0">
          <input
            value={node.name ?? ""}
            onChange={(e) => updateIrNode(node.id, { name: e.target.value })}
            aria-label="Step title"
            className="w-full bg-transparent border-none outline-none text-[13px] font-semibold"
            style={{ color: "var(--orchestr-ink)" }}
          />
          <div
            className="text-[10px] mt-0.5 flex items-center gap-1.5 min-w-0"
            style={{ color: "var(--orchestr-ink-subtle)" }}
          >
            <span className="truncate" title={schema?.support?.reason}>
              {getNodeTypeLabel(node.node_type ?? "")}
            </span>
            <SupportBadge support={schema?.support} />
            <span aria-hidden>·</span>
            {/* The node id IS the reference key, so it's shown to make `{{id}}` legible. */}
            <span className="font-mono truncate" title={`Reference this step as {{${node.id}}}`}>
              {node.id}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close inspector"
          className="bg-transparent border-none p-0 cursor-pointer"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3.5 pb-3 space-y-2.5 min-h-0">
        {/* A broken step's config below is suppressed, since none of it can run. */}
        {isBroken && (
          <div
            className="rounded-lg py-2 px-2.5 text-[11px] flex items-start gap-1.5"
            style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
            role="alert"
            data-testid="node-broken-banner"
          >
            <AlertTriangle size={13} className="shrink-0 mt-[1px]" />
            <div className="min-w-0 flex-1">
              <span>
                <span className="font-semibold">
                  “{node.node_type}” isn’t in the action catalog — it can’t run.
                </span>{" "}
                It was likely removed or renamed. Delete this step and add the current action in its
                place.
              </span>
              <button
                type="button"
                onClick={() => {
                  deleteWorkflowNode(node.id);
                  onClose();
                }}
                className="mt-2 h-7 px-2.5 flex items-center gap-1 rounded-lg text-[11px] font-medium cursor-pointer"
                style={{ background: "var(--orchestr-danger)", border: "none", color: "var(--orchestr-surface-card)" }}
                data-testid="node-broken-delete"
              >
                <Trash2 size={12} /> Delete this step
              </button>
            </div>
          </div>
        )}
        {schema?.description && !nodeIsTrigger(node) && (
          <p
            className="text-[11px] m-0 p-2 rounded-lg leading-relaxed"
            style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
          >
            {schema.description}
          </p>
        )}
        {nodeIsTrigger(node) && (
          <TriggerTypeConfig
            node={node}
            workflowId={workflowId}
            updateIrNode={updateIrNode}
            samples={samples}
            onTriggerSample={(payload) => setSample(scopeKey, "trigger", payload)}
            onClearTriggerSample={() => clearSample("trigger")}
          />
        )}
        {needsConnection && (
          <ConnectionSelectField
            connections={connections}
            error={connectionsError}
            onRetry={reloadConnections}
            appSlug={appSlug}
            value={typeof params.connectionId === "string" ? params.connectionId : ""}
            onChange={(id) => commit("connectionId", id)}
            onConnected={handleConnected}
          />
        )}
        {isIf && (
          <IfEditor
            left={typeof params.left === "string" ? params.left : ""}
            op={typeof params.op === "string" ? params.op : "eq"}
            right={typeof params.right === "string" ? params.right : ""}
            onChange={(patch) => updateIrNode(node.id, { parameters: { ...params, ...patch } })}
            upstream={upstream}
            samples={samples}
            onTriggerSample={(payload) => setSample(scopeKey, "trigger", payload)}
          />
        )}
        {isSwitch && (
          <SwitchCasesEditor
            cases={normalizeCases(params.cases)}
            onCasesChange={(next) => commit("cases", next)}
            onAddCase={() => addSwitchCase(node.id)}
            onRemoveCase={(i) => removeSwitchCase(node.id, i)}
            upstream={upstream}
            samples={samples}
            onTriggerSample={(payload) => setSample(scopeKey, "trigger", payload)}
          />
        )}
        {isCode && (
          <CodeNodeEditor
            nodeId={node.id}
            language={codeLanguage}
            code={codeValue}
            onLanguageChange={(language) => commit("language", language)}
            onCodeChange={(code) => commit("code", code)}
            upstream={upstream}
          />
        )}
        {isLoop && (
          <LoopEditor
            mode={loopMode}
            items={typeof params.items === "string" ? params.items : ""}
            itemVar={typeof params.item_var === "string" ? params.item_var : ""}
            condition={normalizeCondition(params.condition)}
            maxIterations={params.max_iterations}
            onModeChange={(m) => setLoopMode(node.id, m)}
            onItemsChange={(v) => commit("items", v)}
            onItemVarChange={(v) => commit("item_var", v)}
            onConditionChange={(c) => commit("condition", c)}
            onMaxIterationsChange={(v) => commit("max_iterations", v)}
            upstream={upstream}
            samples={samples}
            onTriggerSample={(payload) => setSample(scopeKey, "trigger", payload)}
          />
        )}
        {isAgent && (
          <AgentEditor
            systemPrompt={typeof params.system_prompt === "string" ? params.system_prompt : ""}
            model={agentModelParam(params.model)}
            maxSteps={params.max_steps}
            input={typeof params.input === "string" ? params.input : ""}
            connectionId={typeof params.connectionId === "string" ? params.connectionId : ""}
            onSystemPromptChange={(v) => commit("system_prompt", v)}
            onModelChange={(v) => {
              // Switching provider must clear the connection, or a Claude account rides an OpenAI call.
              const prevProvider = agentModelParam(params.model)?.provider;
              const next: Record<string, unknown> = { ...params, model: v };
              if (v.provider !== prevProvider && typeof next.connectionId === "string") {
                delete next.connectionId;
              }
              updateIrNode(node.id, { parameters: next });
            }}
            onMaxStepsChange={(v) => {
              // Omit the key when cleared, so the compiler applies its own default instead of a null.
              const next = { ...params };
              if (v === undefined) delete next.max_steps;
              else next.max_steps = v;
              updateIrNode(node.id, { parameters: next });
            }}
            onInputChange={(v) => {
              // Empty omits the key, so the compiler applies its whole-trigger-payload fallback.
              const next = { ...params };
              if (v.trim() === "") delete next.input;
              else next.input = v;
              updateIrNode(node.id, { parameters: next });
            }}
            onConnectionChange={(id) => commit("connectionId", id)}
            onConnectionAutoSelect={(id) =>
              updateIrNode(node.id, { parameters: { ...params, connectionId: id } }, { markDirty: false })
            }
            upstream={upstream}
            samples={samples}
            onTriggerSample={(payload) => setSample(scopeKey, "trigger", payload)}
          />
        )}
        {isAgent && workflowJson && (
          <AgentTestPanel
            workflowId={workflowId}
            workflowJson={workflowJson as Record<string, unknown>}
            nodeId={node.id}
            samples={samples}
          />
        )}
        {isCallWorkflow && (
          <CallWorkflowEditor
            value={typeof params.workflow_id === "string" ? params.workflow_id : ""}
            input={paramsObject(params.input)}
            currentWorkflowId={workflowId}
            isAgentTool={isAgentTool}
            onChange={(id) => {
              // Empty clears the key, or an empty string reads as "configured" to the deploy gate.
              // Retargeting drops the old input: its field names belonged to the old workflow.
              const next = { ...params };
              delete next.input;
              if (id === "") delete next.workflow_id;
              else next.workflow_id = id;
              updateIrNode(node.id, { parameters: next });
            }}
            onInputChange={(input) => updateIrNode(node.id, { parameters: { ...params, input } })}
          />
        )}
        {!isBroken &&
          (keys.length === 0 ? (
          // Triggers are fully configured above, so a trailing "no inputs" line would contradict it.
          !nodeIsTrigger(node) &&
          !needsConnection &&
          !isIf &&
          !isSwitch &&
          !isCode &&
          !isLoop &&
          !isAgent &&
          !isCallWorkflow && (
            <div className="text-[12px]" style={{ color: "var(--orchestr-ink-muted)" }}>
              This step has no inputs.
            </div>
          )
        ) : (
          <>
            {keys.filter((key) => !isOptionalHidden(key)).map(renderParamField)}
            {hiddenOptionalCount > 0 && (
              <button
                type="button"
                onClick={() => setShowOptional(true)}
                className="w-full h-7 flex items-center justify-center gap-1 rounded-lg text-[11px] cursor-pointer bg-transparent"
                style={{ border: "1px dashed var(--orchestr-line)", color: "var(--orchestr-ink-subtle)" }}
                data-testid="show-optional-toggle"
              >
                <Plus size={11} /> Show {hiddenOptionalCount} optional field{hiddenOptionalCount === 1 ? "" : "s"}
              </button>
            )}
            {showOptional && optionalHideableCount > 0 && (
              <button
                type="button"
                onClick={() => setShowOptional(false)}
                className="w-full h-7 flex items-center justify-center rounded-lg text-[11px] cursor-pointer bg-transparent"
                style={{ border: "1px dashed var(--orchestr-line)", color: "var(--orchestr-ink-subtle)" }}
                data-testid="hide-optional-toggle"
              >
                Hide empty optional fields
              </button>
            )}
          </>
          ))}
        {nodeType === "orchestr:loop" && (
          <p
            className="text-[11px] m-0 p-2 rounded-lg leading-relaxed"
            style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
          >
            Wire the <strong>body</strong> (first output) to the steps that run each round, and any
            after-loop steps to the <strong>after</strong> output.{" "}
            {loopMode === "items" ? (
              <>
                In the body, reference the current element as{" "}
                <span className="font-mono">{`{{${loopItemVar}}}`}</span>{" "}and its index as{" "}
                <span className="font-mono">{`{{${loopItemVar}Index}}`}</span>.
              </>
            ) : (
              <>
                The body always runs at least once; after each round the condition is checked against
                that round&apos;s output and the loop repeats <strong>while it holds</strong>, up to{" "}
                <strong>max iterations</strong>. In the body reference the round index as{" "}
                <span className="font-mono">{`{{loopRound}}`}</span>{" "}(0-based) and the previous
                round&apos;s outputs as <span className="font-mono">{`{{loopPrev}}`}</span> (undefined
                on round 1).
              </>
            )}{" "}
            After the loop, this step&apos;s per-round outputs are{" "}
            <span className="font-mono">{`{{${node.id}}}`}</span>.
          </p>
        )}
        {/* Only explained when the {} button is actually on screen, i.e. when earlier steps exist. */}
        {!isBroken && upstream.length > 0 && (
          <p className="text-[10px] mt-2 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {/* Explicit {" "} required: SWC drops the boundary space in a multi-line JSX run
                containing an HTML entity (swc #11568). */}
            Use the <Braces size={11} className="inline align-[-1px]" />{" "}button on a field to insert an
            earlier step&apos;s output — or type {"{{step_id.path}}"} yourself ({"{{trigger.path}}"} for
            the trigger).
          </p>
        )}

        {/* The model picks this tool by name + description, so both are editable when it's wired. */}
        {isAgentTool && (
          <div className="pt-2.5 mt-1 space-y-2" style={{ borderTop: "1px solid var(--orchestr-line)" }} data-testid="agent-tool-fields">
            <div className="flex items-center gap-1.5">
              <Wrench size={12} style={{ color: "var(--orchestr-ai)" }} />
              <span className="text-[11px] font-medium" style={{ color: "var(--orchestr-ink)" }}>
                Used as an agent tool
              </span>
            </div>
            <div>
              <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
                Tool name
              </label>
              <input
                type="text"
                value={typeof params.tool_name === "string" ? params.tool_name : ""}
                onChange={(e) => {
                  const next = { ...params };
                  if (e.target.value.trim() === "") delete next.tool_name;
                  else next.tool_name = e.target.value;
                  updateIrNode(node.id, { parameters: next });
                }}
                placeholder={defaultToolName}
                aria-label="Tool name"
                className={FIELD_CLASS}
                style={FIELD_STYLE}
                data-testid="tool-name-input"
              />
              <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
                What the model calls this tool (letters, digits, _ and - survive; empty uses{" "}
                <span className="font-mono">{defaultToolName}</span>).
              </p>
            </div>
            <div>
              <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
                Tool description
              </label>
              <textarea
                value={typeof params.tool_description === "string" ? params.tool_description : ""}
                rows={2}
                onChange={(e) => {
                  const next = { ...params };
                  if (e.target.value.trim() === "") delete next.tool_description;
                  else next.tool_description = e.target.value;
                  updateIrNode(node.id, { parameters: next });
                }}
                placeholder="When should the agent reach for this tool?"
                aria-label="Tool description"
                className="w-full px-2 py-1.5 rounded-lg text-[12px] outline-none resize-y"
                style={FIELD_STYLE}
                data-testid="tool-description-input"
              />
              <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Shown to the model — a one-liner here is what makes it pick the right tool.
              </p>
            </div>
          </div>
        )}

        {/* Per-step error policy (ADR 0020); pure-routing nodes make no call, so it's hidden there. */}
        {!isBroken && !nodeIsTrigger(node) && !isIf && !isSwitch && (
          <div className="pt-2.5 mt-1" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              On failure
            </label>
            <select
              value={params.onError === "continue" ? "continue" : "stop"}
              onChange={(e) => {
                const next = { ...params };
                if (e.target.value === "continue") next.onError = "continue";
                else delete next.onError;
                updateIrNode(node.id, { parameters: next });
              }}
              disabled={hasErrorBranch}
              aria-label="On failure"
              className="w-full h-8 px-2 rounded-lg text-[12px] outline-none disabled:opacity-45 disabled:cursor-not-allowed"
              style={{
                background: "var(--orchestr-field)",
                border: "1px solid var(--orchestr-line)",
                color: "var(--orchestr-ink)",
              }}
              data-testid="on-failure-select"
            >
              <option value="stop" style={{ background: "var(--orchestr-surface-card)" }}>
                Stop the run
              </option>
              <option value="continue" style={{ background: "var(--orchestr-surface-card)" }}>
                Continue — skip this step&apos;s error
              </option>
            </select>
            <p className="text-[10px] mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {hasErrorBranch
                ? "This step's error output is wired to a handler — that branch runs on failure, so this setting doesn't apply."
                : params.onError === "continue"
                  ? `If this step errors, the run keeps going — later steps can read {{${node.id}.error.message}}.`
                  : "If this step errors, the run stops here."}
            </p>
          </div>
        )}

        {/* Retries (ADR 0020) run before the "On failure" policy applies; hidden on routing nodes. */}
        {!isBroken && !nodeIsTrigger(node) && !isIf && !isSwitch && (
          <div className="pt-2.5" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
            <label className="block text-[11px] mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              Retry on failure
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10}
                value={retryAttempts}
                onChange={(e) => setRetry(Math.max(1, Math.min(10, Number(e.target.value) || 1)), retryBackoffMs)}
                aria-label="Max attempts"
                className="w-16 h-8 px-2 rounded-lg text-[12px] outline-none"
                style={{
                  background: "var(--orchestr-field)",
                  border: "1px solid var(--orchestr-line)",
                  color: "var(--orchestr-ink)",
                }}
                data-testid="retry-attempts"
              />
              <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                attempts
              </span>
              {retryAttempts > 1 && (
                <>
                  <input
                    type="number"
                    min={0}
                    max={60000}
                    step={100}
                    value={retryBackoffMs}
                    onChange={(e) => setRetry(retryAttempts, Math.max(0, Math.min(60000, Number(e.target.value) || 0)))}
                    aria-label="Wait between tries in milliseconds"
                    className="w-20 h-8 px-2 rounded-lg text-[12px] outline-none"
                    style={{
                      background: "var(--orchestr-field)",
                      border: "1px solid var(--orchestr-line)",
                      color: "var(--orchestr-ink)",
                    }}
                    data-testid="retry-backoff"
                  />
                  <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    ms wait
                  </span>
                </>
              )}
            </div>
            <p className="text-[10px] mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {retryAttempts > 1
                ? `On failure, retry up to ${retryAttempts} times before the “On failure” policy applies.`
                : "Runs once — set attempts above 1 to retry on failure."}
            </p>
          </div>
        )}

        {canTest && (
          <div className="pt-2.5 mt-1" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
            <button
              type="button"
              onClick={runTest}
              disabled={test.phase === "running" || hasRequiredEmpty || isBroken || connectionMissing}
              title={
                isBroken
                  ? "This step's type isn't in the action catalog, so it can't run."
                  : hasRequiredEmpty
                    ? `Fill the required field${requiredEmptyKeys.length === 1 ? "" : "s"} first: ${requiredEmptyKeys
                        .map(humanizeKey)
                        .join(", ")}`
                    : connectionMissing
                      ? "Connect an account first."
                      : undefined
              }
              className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                background: "var(--orchestr-accent-tint)",
                border: "1px solid var(--orchestr-line)",
                color: "var(--orchestr-ink)",
              }}
              data-testid="test-step-button"
            >
              {test.phase === "running" ? (
                <>
                  <SaratiLoader size={13} /> Running…
                </>
              ) : (
                <>
                  <Play size={12} className="align-[-1px]" /> Test this step
                </>
              )}
            </button>
            {/* An empty required field would hit the provider blank and fail obscurely. */}
            {hasRequiredEmpty && (
              <p
                className="text-[10px] m-0 mt-1 leading-snug"
                style={{ color: "var(--orchestr-warning)" }}
                data-testid="test-step-required-block"
              >
                Fill {requiredEmptyKeys.map(humanizeKey).join(", ")} before testing this step.
              </p>
            )}
            {/* Without an account the real provider call can only fail, so point at the select above. */}
            {connectionMissing && !hasRequiredEmpty && (
              <p
                className="text-[10px] m-0 mt-1 leading-snug"
                style={{ color: "var(--orchestr-warning)" }}
                data-testid="test-step-connection-block"
              >
                Connect an account above before testing this step.
              </p>
            )}
            {!isBroken && (
              <p className="text-[10px] m-0 mt-1 leading-snug" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Runs just this step with its current inputs and shows the real output — its fields then
                appear in the data picker of later steps.
              </p>
            )}
            {/* A test hits the provider for real — there is no dry-run — so say so, in the shared wording. */}
            {needsConnection && (
              <p
                className="text-[10px] m-0 mt-1 leading-snug flex items-start gap-1"
                style={{ color: "var(--orchestr-warning)" }}
                data-testid="test-step-real-effects"
              >
                <AlertTriangle size={11} className="shrink-0 mt-[1px]" />
                <span>{REAL_RUN_STEP_NOTE}</span>
              </p>
            )}

            {/* Captured output feeds later pickers; PINNING it (ADR 0021) also skips executing the step. */}
            {Object.prototype.hasOwnProperty.call(samples, node.id) && (
              <div
                className="flex items-center gap-1.5 mt-1.5 text-[10px]"
                style={{ color: "var(--orchestr-ink-muted)" }}
                data-testid="step-pinned-chip"
              >
                <Pin
                  size={10}
                  style={{ color: isPinned ? "var(--orchestr-ai)" : "var(--orchestr-ink-subtle)" }}
                />
                <span>
                  {isPinned
                    ? "Pinned — a run replays this data and does not execute this step."
                    : "Captured — later steps build against this step’s data."}
                </span>
                <button
                  type="button"
                  onClick={() => (isPinned ? unpinStep(node.id) : pinStep(node.id))}
                  className="ml-auto shrink-0 bg-transparent border-none cursor-pointer underline underline-offset-2 p-0"
                  style={{ color: isPinned ? "var(--orchestr-ink-subtle)" : "var(--orchestr-ai)" }}
                  data-testid="step-pin-toggle"
                >
                  {isPinned ? "Unpin" : "Pin for runs"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearSample(node.id);
                    setTest({ phase: "idle" });
                  }}
                  className="shrink-0 bg-transparent border-none cursor-pointer underline underline-offset-2 p-0"
                  style={{ color: "var(--orchestr-ink-subtle)" }}
                  data-testid="step-clear-sample"
                >
                  Clear
                </button>
              </div>
            )}

            {test.phase === "done" && (
              <div className="mt-2">
                {test.missing.length > 0 && (
                  <p className="text-[10px] m-0 mb-1 leading-snug" style={{ color: "var(--orchestr-warning)" }}>
                    Empty values were used for {test.missing.map(missingLabel).join(", ")} — test{" "}
                    {test.missing.length === 1 ? "it" : "them"}{" "}first for a real preview.
                  </p>
                )}
                {/* Non-fatal: the step succeeded, so this reads amber rather than error-red. */}
                {test.warnings.length > 0 && (
                  <div
                    className="mb-1.5 rounded-lg px-2 py-1.5 flex items-start gap-1.5"
                    style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
                    data-testid="test-step-warnings"
                  >
                    <AlertTriangle size={12} className="shrink-0 mt-[2px]" />
                    <div className="min-w-0">
                      {test.warnings.map((w, i) => (
                        <p
                          key={i}
                          className={`text-[10.5px] leading-snug break-words m-0 ${i > 0 ? "mt-0.5" : ""}`}
                        >
                          {w}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
                {/* Data panel: what this step received vs what it returned. */}
                <div
                  className="inline-flex p-0.5 rounded-lg mb-1.5"
                  style={{ background: "var(--orchestr-surface-raised)", border: "1px solid var(--orchestr-line)" }}
                  role="tablist"
                >
                  {(["input", "output"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={dataTab === t}
                      onClick={() => setDataTab(t)}
                      className="px-2.5 h-6 rounded-md text-[10.5px] font-medium capitalize cursor-pointer border-none transition-colors"
                      style={
                        dataTab === t
                          ? { background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }
                          : { background: "transparent", color: "var(--orchestr-ink-subtle)" }
                      }
                      data-testid={`test-step-tab-${t}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <pre
                  className="text-[10.5px] font-mono m-0 p-2 rounded-lg overflow-auto whitespace-pre-wrap break-words"
                  style={{
                    background: "var(--orchestr-field)",
                    border: "1px solid var(--orchestr-line)",
                    color: "var(--orchestr-ink)",
                    maxHeight: 220,
                  }}
                  data-testid={dataTab === "input" ? "test-step-input" : "test-step-output"}
                >
                  {dataTab === "input"
                    ? Object.keys(test.input ?? {}).length === 0
                      ? "(this step reads no upstream data)"
                      : JSON.stringify(test.input ?? {}, null, 2)
                    : test.output === undefined
                      ? "(this step produced no output)"
                      : JSON.stringify(test.output, null, 2)}
                </pre>
              </div>
            )}

            {test.phase === "error" && (
              <div className="mt-2">
                {test.missing.length > 0 && (
                  <p
                    className="text-[10px] m-0 mb-1 leading-snug"
                    style={{ color: "var(--orchestr-warning)" }}
                    data-testid="test-step-missing-nudge"
                  >
                    {`This step reads ${test.missing.map((m) => `{{${m}}}`).join(", ")} but there's no sample for ${test.missing
                      .map(missingLabel)
                      .join(
                        ", ",
                      )} yet, so empty values were used — that's the usual cause of this failure. Open the data picker ({}) on any field and paste or catch a sample event, then test again.`}
                  </p>
                )}
                <p
                  className="text-[10.5px] m-0 p-2 rounded-lg leading-snug break-words"
                  style={{
                    background: "var(--orchestr-field)",
                    border: "1px solid var(--orchestr-danger)",
                    color: "var(--orchestr-danger)",
                  }}
                  data-testid="test-step-error"
                >
                  {test.message}
                </p>
                {/* The input shows even on failure — that's where the reason usually is. */}
                {Object.keys(test.input ?? {}).length > 0 && (
                  <>
                    <div className="text-[10px] mt-2 mb-1" style={{ color: "var(--orchestr-ink-muted)" }}>
                      Input the step received
                    </div>
                    <pre
                      className="text-[10.5px] font-mono m-0 p-2 rounded-lg overflow-auto whitespace-pre-wrap break-words"
                      style={{
                        background: "var(--orchestr-field)",
                        border: "1px solid var(--orchestr-line)",
                        color: "var(--orchestr-ink)",
                        maxHeight: 200,
                      }}
                      data-testid="test-step-error-input"
                    >
                      {JSON.stringify(test.input ?? {}, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
