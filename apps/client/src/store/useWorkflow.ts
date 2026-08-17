"use client";

import { create } from "zustand";
import * as api from "@/api/client";
import { toast } from "@/lib/toast";
import * as irGraph from "@/lib/irGraph";
import { irContentKey } from "@/lib/irCompare";
import { defaultParamsFromSchema } from "@/lib/constants";
import type {
  ExtractionResult,
  DiscoveredNode,
  WorkflowSummary,
  ConfigurationResponse,
} from "@/api/client";

/** The unnamed workflow's name — the ONE place it is spelled, so "was it renamed?" has one answer. */
export const UNTITLED_WORKFLOW = "Untitled workflow";

export type View = "dashboard" | "pipeline";

export type Step =
  "chat" | "extract" | "discover" | "generate" | "preview" | "execute";

export interface Message {
  role: "user" | "ai";
  text: string;
}

/** Canvas content-edit history: prior documents (past) and undone ones (future). */
export interface CanvasHistory {
  past: Array<Record<string, unknown>>;
  future: Array<Record<string, unknown>>;
}

/** The head-moved-under-us facts a 409 `branch_moved` carries (ADR 0034 B5). */
export interface BranchMovedState {
  /** The version now at the branch head — what rebase/discard reload onto. */
  currentHeadVersionId: string;
  /** Its number, for the dialog copy ("someone committed v7 while you edited"). */
  currentHeadVersionNumber: number;
  /** The stale base we tried to commit against (echoed by the service). */
  baseVersionId: string | null;
}

interface WorkflowState {
  // View routing
  view: View;

  // Pipeline state
  step: Step;
  messages: Message[];
  requirements: ExtractionResult | null;
  discoveredNodes: DiscoveredNode[];
  discoveryQuery: string;
  workflowJson: Record<string, unknown> | null;
  // workflowJson IS the IR document; mirrored here because the canvas renders from workflowIr.
  workflowIr: Record<string, unknown> | null;
  nodeCount: number;
  connectionsCount: number;
  workflowId: string | null;
  workflowUrl: string | null;
  workflowName: string | null;
  isLoading: boolean;
  error: string | null;
  warning: string | null;
  stripReady: boolean;
  originalMessage: string;

  // ── Creation-canvas editor ──
  /** "draft" = pre-deploy (edits live only in the store); "deployed" = Save commits a new version. */
  editorMode: "draft" | "deployed";
  /** Uncommitted edits exist vs lastGeneratedJson (draft) or the saved head (deployed). */
  dirty: boolean;
  /** Snapshot backing "Revert edits" — the baseline the working doc is dirty against. */
  lastGeneratedJson: Record<string, unknown> | null;

  // Dashboard state
  workflows: WorkflowSummary[];
  dashboardLoading: boolean;
  dashboardLoadingMore: boolean;
  dashboardError: string | null;
  dashboardTotal: number;
  dashboardHasMore: boolean;
  dashboardOffset: number;
  highlightedWorkflowId: string | null;
  selectedWorkflowId: string | null;
  selectedConfig: ConfigurationResponse | null;

  // Pipeline actions
  deploy: () => Promise<void>;
  goToStep: (step: Step) => void;
  setStripReady: (ready: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;

  // ── Canvas undo/redo ──
  /** Content-edit history (positions excluded — layout is presentation, not history). */
  history: CanvasHistory;
  /** Revert to the previous committed content edit (no-op when the past is empty). */
  undo: () => void;
  /** Re-apply the most recently undone content edit (no-op when the future is empty). */
  redo: () => void;

  // Canvas/graph editing (Review step editor)
  updateNodePosition: (name: string, x: number, y: number) => void;
  /** Seed a fresh built-in document (trigger only) for from-scratch authoring. */
  startScratch: () => void;
  /** Add a catalog action / control node to the IR document, wired from the current leaf. */
  addIrNodeFromCatalog: (entry: import("@/api/client").NodeTypeEntry) => void;
  /** Patch an IR node's display name, parameters, and/or node_type (inspector). */
  updateIrNode: (
    nodeId: string,
    patch: {
      name?: string;
      parameters?: Record<string, unknown>;
      node_type?: string;
      metadata?: Record<string, unknown>;
    },
    opts?: { markDirty?: boolean },
  ) => void;
  /** Rename the working document (deploy uses workflowJson.name). */
  setWorkflowDocName: (name: string) => void;
  /** Append an empty Switch case; the default slides one port up so its wire stays the default. */
  addSwitchCase: (nodeId: string) => void;
  /** Remove a Switch case (keeping at least one); higher ports slide down so wires still follow their case. */
  removeSwitchCase: (nodeId: string, index: number) => void;
  /** Switch a loop between `items` and `while` (ADR 0029), seeding `while`'s required fields and keeping the other mode's. */
  setLoopMode: (nodeId: string, mode: "items" | "while") => void;
  deleteWorkflowNode: (name: string) => void;
  /** Paste nodes with fresh collision-free ids; only edges with BOTH endpoints copied survive. Returns the new ids. */
  pasteNodes: (
    nodes: Array<Record<string, unknown>>,
    edges: Array<Record<string, unknown>>,
  ) => string[];
  addWorkflowConnection: (
    source: string,
    target: string,
    port?: number,
    portType?: "main" | "error" | "tool",
  ) => void;
  removeWorkflowConnection: (
    source: string,
    target: string,
    port?: number,
    portType?: "main" | "error" | "tool",
  ) => void;
  revertEdits: () => void;
  beginDeployedEdit: () => void;
  saveDeployedEdits: (message?: string) => Promise<void>;
  /** Load a branch's HEAD graph into the editor in "deployed" mode; resolves true on success. */
  loadForEdit: (
    workflowId: string,
    branch?: string,
    fromVersion?: number,
  ) => Promise<boolean>;
  /** Which branch the editor is working on — set by loadForEdit, read by saveDeployedEdits. */
  editBranch: string;
  /** Opened FROM an old version (continue-from-vN): Save still appends a NEW head — vN stays immutable. */
  editFromVersion: number | null;
  /** Optimistic-concurrency base (ADR 0034 B5): the head version this doc was last synced from. */
  baseVersionId: string | null;
  /** Set on a 409 `branch_moved`; drives BranchMovedDialog — we never silently retry or overwrite. */
  branchMoved: BranchMovedState | null;
  /** Three-way-merge our edits onto the moved-on head, then re-commit against the fresh base. */
  rebaseOntoHead: () => Promise<void>;
  /** Drop local edits and load the current head as the clean baseline. */
  discardAndLoadHead: () => Promise<void>;
  /** Close the branch-moved dialog without resolving (keeps local edits intact). */
  dismissBranchMoved: () => void;
  /** Load an IR doc as unsaved working state; leaves `lastGeneratedJson` alone so Revert still targets the baseline. */
  resumeDraftIr: (ir: Record<string, unknown>) => void;

  // View actions
  goToDashboard: () => void;

  // Dashboard actions
  fetchWorkflows: () => Promise<void>;
  loadMoreWorkflows: () => Promise<void>;
  deleteWorkflow: (id: string) => Promise<void>;
  selectWorkflow: (id: string | null) => void;
  fetchWorkflowConfig: (id: string) => Promise<ConfigurationResponse | null>;
  executeFromDashboard: (
    id: string,
    inputs?: Record<string, unknown>,
  ) => Promise<string | null>;
  clearHighlight: () => void;
}

/** W2: the save succeeded — but say which data refs would break the run. */
function warnBrokenRefs(warnings: string[] | undefined): void {
  if (!warnings || warnings.length === 0) return;
  const [first, ...rest] = warnings;
  toast.warning(
    "Saved, but a data reference looks broken",
    rest.length > 0 ? `${first} (+${rest.length} more)` : first,
  );
}

/** The workflow was created — but its trigger never came up, so nothing will fire it yet. */
function warnInactiveTrigger(result: api.DeployResult): void {
  if (result.activated !== false) return;
  toast.warning(
    "Created, but the trigger is not live yet",
    result.activation_error ?? undefined,
  );
}

/** Node count on an IR document. */
function workflowNodeCount(workflow: Record<string, unknown>): number {
  return Array.isArray(workflow.nodes)
    ? (workflow.nodes as unknown[]).length
    : 0;
}

/** Edge count on an IR document. */
function workflowConnectionCount(workflow: Record<string, unknown>): number {
  return Array.isArray(workflow.edges)
    ? (workflow.edges as unknown[]).length
    : 0;
}

// Graph surgery requires both mirrors to be IR documents.
function canEditIrGraph(s: WorkflowState): boolean {
  return (
    irGraph.isIrDocument(s.workflowJson) && irGraph.isIrDocument(s.workflowIr)
  );
}

// ─── Draft persistence ───
// The draft slice round-trips through sessionStorage so F5 resumes; closing the tab discards it, by design.

const DRAFT_KEY = "orchestr_pipeline_draft";

type DraftSlice = Pick<
  WorkflowState,
  | "view"
  | "step"
  | "messages"
  | "requirements"
  | "discoveredNodes"
  | "discoveryQuery"
  | "workflowJson"
  | "workflowIr"
  | "nodeCount"
  | "connectionsCount"
  | "workflowId"
  | "workflowUrl"
  | "workflowName"
  | "stripReady"
  | "originalMessage"
  | "editorMode"
  | "dirty"
  | "lastGeneratedJson"
>;

function loadDraft(): Partial<DraftSlice> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as DraftSlice;
    if (draft.view !== "pipeline") return null;
    // Land every resumable draft on the phase that can actually continue it.
    if (draft.step === "extract" || draft.step === "discover") {
      draft.step = "chat";
    }
    if (draft.step === "generate" && !draft.stripReady) {
      draft.step = "chat";
      draft.workflowJson = null;
      draft.workflowIr = null;
      draft.nodeCount = 0;
      draft.connectionsCount = 0;
    }
    if (draft.step === "chat" && draft.discoveredNodes?.length) {
      draft.stripReady = true;
    }
    // The preview always carries its action strip.
    if (draft.step === "preview" && draft.workflowJson) {
      draft.stripReady = true;
    }
    // "deployed" editing needs a workflow id to sync against.
    if (draft.editorMode === "deployed" && !draft.workflowId) {
      draft.editorMode = "draft";
      draft.dirty = false;
    }
    return draft;
  } catch {
    return null;
  }
}

function saveDraft(s: WorkflowState): void {
  try {
    if (
      s.view !== "pipeline" ||
      (s.step === "chat" && s.messages.length === 0)
    ) {
      sessionStorage.removeItem(DRAFT_KEY);
      return;
    }
    const draft: DraftSlice = {
      view: s.view,
      step: s.step,
      messages: s.messages,
      requirements: s.requirements,
      discoveredNodes: s.discoveredNodes,
      discoveryQuery: s.discoveryQuery,
      workflowJson: s.workflowJson,
      workflowIr: s.workflowIr,
      nodeCount: s.nodeCount,
      connectionsCount: s.connectionsCount,
      workflowId: s.workflowId,
      workflowUrl: s.workflowUrl,
      workflowName: s.workflowName,
      stripReady: s.stripReady,
      originalMessage: s.originalMessage,
      editorMode: s.editorMode,
      dirty: s.dirty,
      lastGeneratedJson: s.lastGeneratedJson,
    };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded or serialization failure — the draft just isn't saved.
  }
}

function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

// Debounced layout writer: moves on a saved head PATCH coordinates in place (no version, no dirty).
const pendingLayout: {
  wfId: string | null;
  branch: string;
  positions: Record<string, { x: number; y: number }>;
} = {
  wfId: null,
  branch: "main",
  positions: {},
};
let layoutTimer: ReturnType<typeof setTimeout> | null = null;
function queueLayoutPatch(
  wfId: string,
  branch: string,
  nodeId: string,
  x: number,
  y: number,
): void {
  if (pendingLayout.wfId !== wfId || pendingLayout.branch !== branch) {
    pendingLayout.wfId = wfId;
    pendingLayout.branch = branch;
    pendingLayout.positions = {};
  }
  pendingLayout.positions[nodeId] = { x, y };
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    const { wfId: id, branch: br, positions } = pendingLayout;
    pendingLayout.wfId = null;
    pendingLayout.positions = {};
    if (!id) return;
    void api.patchWorkflowLayout(id, br, positions).catch(() => {
      /* quiet: presentation only — reload shows the last persisted layout */
    });
  }, 900);
}

// ─── Canvas undo/redo history ───
// "Did the content change?" is answered ONLY by irContentKey (the vault rule), so a layout-only
// drag shares its key and never creates an undo step.
const HISTORY_LIMIT = 50;
const HISTORY_COMMIT_MS = 400;

function emptyHistory(): CanvasHistory {
  return { past: [], future: [] };
}

// The last document folded into history and its content key — the reference the next change is measured
// against. Module-scoped so it never re-renders and never serialises into the session draft.
let historyBaseline: Record<string, unknown> | null = null;
let historyBaselineKey: string | null = null;
let historyTimer: ReturnType<typeof setTimeout> | undefined;

// Adopt a document as the history baseline, cancelling any pending debounced commit.
function primeHistoryBaseline(doc: Record<string, unknown> | null): void {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = undefined;
  }
  historyBaseline = irGraph.isIrDocument(doc) ? doc : null;
  historyBaselineKey = historyBaseline ? irContentKey(historyBaseline) : null;
}

// The set() patch that restores a document; `dirty` is decided by irContentKey, never a byte-compare.
function historyRestorePatch(
  doc: Record<string, unknown>,
  history: CanvasHistory,
  lastGeneratedJson: Record<string, unknown> | null,
): Partial<WorkflowState> {
  return {
    workflowJson: doc,
    workflowIr: irGraph.isIrDocument(doc) ? doc : null,
    history,
    nodeCount: workflowNodeCount(doc),
    connectionsCount: workflowConnectionCount(doc),
    dirty: lastGeneratedJson
      ? irContentKey(doc) !== irContentKey(lastGeneratedJson)
      : true,
  };
}

// Fold the current document into the past IFF its content differs from the baseline.
function commitHistorySnapshot(): void {
  const doc = useWorkflow.getState().workflowJson;
  if (!irGraph.isIrDocument(doc)) return;
  const key = irContentKey(doc);
  // First sight of a document: adopt it as the baseline — there's nothing before it to return to.
  if (historyBaselineKey === null) {
    historyBaseline = doc;
    historyBaselineKey = key;
    return;
  }
  if (key === historyBaselineKey) return; // layout-only or no-op change
  const previous = historyBaseline;
  historyBaseline = doc;
  historyBaselineKey = key;
  useWorkflow.setState((s) => ({
    history: {
      past: previous
        ? [...s.history.past, previous].slice(-HISTORY_LIMIT)
        : s.history.past,
      future: [], // a fresh edit invalidates the redo stack
    },
  }));
}

// Run the pending commit before an undo/redo reads the stacks, so an in-debounce edit gets its own step.
function flushHistoryCommit(): void {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = undefined;
  }
  commitHistorySnapshot();
}

export const useWorkflow = create<WorkflowState>((set, get) => ({
  view: "dashboard",
  step: "chat",
  messages: [],
  requirements: null,
  discoveredNodes: [],
  discoveryQuery: "",
  workflowJson: null,
  workflowIr: null,
  nodeCount: 0,
  connectionsCount: 0,
  workflowId: null,
  workflowUrl: null,
  workflowName: null,
  isLoading: false,
  error: null,
  warning: null,
  stripReady: false,
  originalMessage: "",
  editorMode: "draft",
  editBranch: "main",
  editFromVersion: null,
  baseVersionId: null,
  branchMoved: null,
  dirty: false,
  lastGeneratedJson: null,
  history: emptyHistory(),
  // Resume a refresh-interrupted draft — must stay LAST so it overrides the defaults above.
  ...(loadDraft() ?? {}),

  workflows: [],
  dashboardLoading: false,
  dashboardLoadingMore: false,
  dashboardError: null,
  dashboardTotal: 0,
  dashboardHasMore: false,
  dashboardOffset: 0,
  highlightedWorkflowId: null,
  selectedWorkflowId: null,
  selectedConfig: null,

  // ─── Pipeline Actions ───

  deploy: async () => {
    const { workflowJson, workflowId } = get();
    if (!workflowJson) return;

    set({ isLoading: true, error: null, warning: null, stripReady: false });
    try {
      const deployResult = await api.deployWorkflow(
        workflowJson,
        workflowId ?? undefined,
      );
      set({
        workflowId: deployResult.workflow_id,
        workflowUrl: deployResult.workflow_url,
        workflowName: deployResult.name,
        highlightedWorkflowId: deployResult.workflow_id,
        isLoading: false,
        step: "execute",
      });
      toast.success(
        "Created on Sarati",
        `"${deployResult.name}" is under version control — v1 on main`,
      );
      warnBrokenRefs(deployResult.ref_warnings);
      warnInactiveTrigger(deployResult);
    } catch (e) {
      // Restore the strip so Deploy stays reachable after a failure.
      set({
        isLoading: false,
        stripReady: true,
        error: e instanceof Error ? e.message : "Failed to create workflow",
      });
    }
  },

  goToStep: (step: Step) => set({ step, stripReady: false }),

  setStripReady: (ready: boolean) => set({ stripReady: ready }),

  setError: (error: string | null) => set({ error }),

  reset: () => {
    clearDraft();
    primeHistoryBaseline(null);
    set({
      step: "chat",
      messages: [],
      requirements: null,
      discoveredNodes: [],
      discoveryQuery: "",
      workflowJson: null,
      workflowIr: null,
      nodeCount: 0,
      connectionsCount: 0,
      workflowId: null,
      workflowUrl: null,
      workflowName: null,
      isLoading: false,
      error: null,
      warning: null,
      stripReady: false,
      originalMessage: "",
      editorMode: "draft",
      baseVersionId: null,
      branchMoved: null,
      dirty: false,
      lastGeneratedJson: null,
      history: emptyHistory(),
    });
  },

  undo: () => {
    flushHistoryCommit();
    const s = get();
    const { past, future } = s.history;
    if (past.length === 0) return;
    const previous = past[past.length - 1]!;
    const current = s.workflowJson;
    // Prime BEFORE set(), so the commit the resulting change schedules sees no diff and stays a no-op.
    primeHistoryBaseline(previous);
    set(
      historyRestorePatch(
        previous,
        {
          past: past.slice(0, -1),
          future: current ? [...future, current] : future,
        },
        s.lastGeneratedJson,
      ),
    );
  },

  redo: () => {
    flushHistoryCommit();
    const s = get();
    const { past, future } = s.history;
    if (future.length === 0) return;
    const next = future[future.length - 1]!;
    const current = s.workflowJson;
    primeHistoryBaseline(next);
    set(
      historyRestorePatch(
        next,
        {
          past: current ? [...past, current].slice(-HISTORY_LIMIT) : past,
          future: future.slice(0, -1),
        },
        s.lastGeneratedJson,
      ),
    );
  },

  // ─── Canvas Editor Actions ───
  // All graph edits flow through lib/irGraph so untouched nodes keep object identity —
  // the canvas's incremental parser depends on it.

  startScratch: () => {
    get().reset();
    const trigger = {
      id: "trigger",
      name: "Trigger",
      node_type: "orchestr:trigger",
      type_version: 1,
      parameters: {},
      position: { x: 60, y: 300 },
      metadata: {},
    };
    const doc: Record<string, unknown> = {
      version: "1",
      name: UNTITLED_WORKFLOW,
      description: "",
      nodes: [trigger],
      edges: [],
      settings: {
        timezone: null,
        error_workflow: null,
        execution_timeout: null,
      },
      metadata: { engine: "orchestr" },
    };
    set({
      workflowJson: doc,
      workflowIr: doc,
      editorMode: "deployed",
      step: "preview",
      nodeCount: 1,
      connectionsCount: 0,
      dirty: false,
      history: emptyHistory(),
    });
    // The seeded doc is the undo floor — the first authored edit reverts to it.
    primeHistoryBaseline(doc);
  },

  addIrNodeFromCatalog: (entry) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    const doc = s.workflowJson!;
    const nodes = irGraph.getIrNodes(doc);
    const base =
      entry.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "step";
    let id = base;
    for (let i = 2; nodes.some((n) => n.id === id); i += 1) id = `${base}_${i}`;

    // Wire from the current leaf and place one column right of the widest node.
    const edges = irGraph.getIrEdges(doc);
    const hasOut = new Set(edges.map((e) => e.source_node_id));
    const leaf = [...nodes].reverse().find((n) => !hasOut.has(n.id)) ?? null;
    const maxX = nodes.reduce((m, n) => Math.max(m, n.position?.x ?? 0), 0);
    const defaults: Record<string, unknown> =
      entry.type === "orchestr:if"
        ? { left: "", op: "eq", right: "" }
        : entry.type === "orchestr:switch"
          ? // The engine requires a non-empty `cases` array.
            { cases: [{ left: "", op: "eq", right: "" }] }
          : entry.type === "orchestr:wait_for_event"
            ? { topic: "", timeout_ms: 3_600_000 }
            : entry.type === "orchestr:loop"
              ? { items: "", item_var: "item" }
              : entry.type === "orchestr:code"
                ? // A runnable starter, so the node isn't dropped with a blank required field.
                  { language: "js", code: "// steps holds earlier outputs, trigger the firing event\nreturn steps;" }
                : // Seed schema-declared defaults, so a new action isn't dropped with an empty required field.
                  defaultParamsFromSchema(entry.parameters);
    const node = {
      id,
      name: entry.name,
      node_type: entry.type,
      type_version: 1,
      parameters: defaults,
      position: { x: maxX + 300, y: leaf?.position?.y ?? 300 },
      metadata: {},
    };
    const patch = (d: Record<string, unknown>): Record<string, unknown> => {
      const withNode = irGraph.addIrNode(d, node);
      return leaf ? irGraph.addIrEdge(withNode, leaf.id, id) : withNode;
    };
    const nextJson = patch(doc);
    set({
      workflowJson: nextJson,
      workflowIr: patch(s.workflowIr!),
      dirty: true,
      nodeCount: irGraph.getIrNodes(nextJson).length,
      connectionsCount: irGraph.countIrEdges(nextJson),
    });
  },

  updateIrNode: (nodeId, patch, opts) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    const next = irGraph.updateIrNode(s.workflowJson!, nodeId, patch);
    if (next === s.workflowJson) return;
    set({
      workflowJson: next,
      workflowIr: irGraph.updateIrNode(s.workflowIr!, nodeId, patch),
      // markDirty:false = a programmatic default, which must not arm Save or autosave a draft.
      ...(opts?.markDirty === false ? {} : { dirty: true }),
    });
  },

  addSwitchCase: (nodeId) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    const node = irGraph.getIrNodes(s.workflowJson!).find((n) => n.id === nodeId);
    if (!node || node.node_type !== "orchestr:switch") return;
    const cases = Array.isArray(node.parameters?.cases)
      ? (node.parameters!.cases as unknown[])
      : [];
    // The new case takes the old default's port; the default slides up one so its wire still routes "no match".
    const oldDefaultPort = cases.length;
    const nextParams = { ...(node.parameters ?? {}), cases: [...cases, { left: "", op: "eq", right: "" }] };
    const apply = (doc: Record<string, unknown>): Record<string, unknown> => {
      const shifted = irGraph.remapOutgoingMainPorts(doc, nodeId, (p) =>
        p >= oldDefaultPort ? p + 1 : p,
      );
      return irGraph.updateIrNode(shifted, nodeId, { parameters: nextParams });
    };
    const nextJson = apply(s.workflowJson!);
    set({
      workflowJson: nextJson,
      workflowIr: apply(s.workflowIr!),
      dirty: true,
      connectionsCount: irGraph.countIrEdges(nextJson),
    });
  },

  removeSwitchCase: (nodeId, index) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    const node = irGraph.getIrNodes(s.workflowJson!).find((n) => n.id === nodeId);
    if (!node || node.node_type !== "orchestr:switch") return;
    const cases = Array.isArray(node.parameters?.cases)
      ? (node.parameters!.cases as unknown[])
      : [];
    // The engine requires a non-empty `cases` array — never remove the last one.
    if (index < 0 || index >= cases.length || cases.length <= 1) return;
    const nextParams = { ...(node.parameters ?? {}), cases: cases.filter((_, i) => i !== index) };
    const apply = (doc: Record<string, unknown>): Record<string, unknown> => {
      // Drop the removed case's wire and slide higher ports down one, so surviving wires follow their case.
      const remapped = irGraph.remapOutgoingMainPorts(doc, nodeId, (p) =>
        p === index ? null : p > index ? p - 1 : p,
      );
      return irGraph.updateIrNode(remapped, nodeId, { parameters: nextParams });
    };
    const nextJson = apply(s.workflowJson!);
    set({
      workflowJson: nextJson,
      workflowIr: apply(s.workflowIr!),
      dirty: true,
      connectionsCount: irGraph.countIrEdges(nextJson),
    });
  },

  setLoopMode: (nodeId, mode) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    const node = irGraph.getIrNodes(s.workflowJson!).find((n) => n.id === nodeId);
    if (!node || node.node_type !== "orchestr:loop") return;
    const params = node.parameters ?? {};
    const current = params.mode === "while" ? "while" : "items";
    if (current === mode) return;
    const next: Record<string, unknown> = { ...params, mode };
    // The service rejects a `while` loop with no condition or a non-positive-integer cap — seed both.
    if (mode === "while") {
      if (next.condition === null || typeof next.condition !== "object") {
        next.condition = { left: "", op: "eq", right: "" };
      }
      if (typeof next.max_iterations !== "number") next.max_iterations = 100;
    }
    const apply = (doc: Record<string, unknown>): Record<string, unknown> =>
      irGraph.updateIrNode(doc, nodeId, { parameters: next });
    const nextJson = apply(s.workflowJson!);
    set({ workflowJson: nextJson, workflowIr: apply(s.workflowIr!), dirty: true });
  },

  setWorkflowDocName: (name) => {
    const s = get();
    if (!s.workflowJson) return;
    set({
      workflowJson: { ...s.workflowJson, name },
      ...(irGraph.isIrDocument(s.workflowIr)
        ? { workflowIr: { ...s.workflowIr!, name } }
        : {}),
    });
  },

  updateNodePosition: (name: string, x: number, y: number) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    // `name` is the IR node id; both mirrors are patched so Save persists the move.
    const patch = (doc: Record<string, unknown>): Record<string, unknown> => ({
      ...doc,
      nodes: (doc.nodes as Array<Record<string, unknown>>).map((n) =>
        n.id === name ? { ...n, position: { x, y } } : n,
      ),
    });
    // Layout is presentation, not history: on a saved workflow a move never dirties the editor.
    const savedHead = s.editorMode === "deployed" && s.workflowId !== null;
    // Only the HEAD view persists coordinates; a vN view's moves are ephemeral. Neither arms Save.
    const patchesLayout = savedHead && s.editFromVersion === null;
    set({
      workflowIr: patch(s.workflowIr as Record<string, unknown>),
      workflowJson: patch(s.workflowJson as Record<string, unknown>),
      ...(savedHead ? {} : { dirty: true }),
    });
    if (patchesLayout)
      queueLayoutPatch(s.workflowId!, s.editBranch, name, x, y);
  },

  deleteWorkflowNode: (name: string) => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    // `name` is the IR node id; both mirrors are patched (canvas renders workflowIr, Save commits workflowJson).
    const next = irGraph.deleteIrNode(s.workflowJson!, name);
    set({
      workflowJson: next,
      workflowIr: irGraph.deleteIrNode(s.workflowIr!, name),
      dirty: true,
      nodeCount: irGraph.getIrNodes(next).length,
      connectionsCount: irGraph.countIrEdges(next),
    });
  },

  pasteNodes: (nodes, edges) => {
    const s = get();
    if (!canEditIrGraph(s) || nodes.length === 0) return [];
    const PASTE_OFFSET = 40;
    // `taken` accumulates, so a pasted batch never collides with itself either.
    const taken = new Set(irGraph.getIrNodes(s.workflowJson!).map((n) => n.id));
    const idMap = new Map<string, string>();
    const cloned = nodes.map((n) => {
      const oldId = String(n.id ?? "");
      const base =
        String(n.name ?? "step")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 40) || "step";
      let id = base;
      for (let i = 2; taken.has(id); i += 1) id = `${base}_${i}`;
      taken.add(id);
      if (oldId) idMap.set(oldId, id);
      const pos = (n.position as { x?: number; y?: number }) ?? {};
      return {
        ...n,
        id,
        position: { x: (pos.x ?? 0) + PASTE_OFFSET, y: (pos.y ?? 0) + PASTE_OFFSET },
      };
    });
    // An edge survives only when BOTH endpoints were copied, so a clone starts detached.
    const clonedEdges = edges
      .filter(
        (e) =>
          idMap.has(String(e.source_node_id)) &&
          idMap.has(String(e.target_node_id)),
      )
      .map((e) => {
        const src = idMap.get(String(e.source_node_id))!;
        const tgt = idMap.get(String(e.target_node_id))!;
        const port = Number(e.source_port ?? 0);
        return {
          ...e,
          id: port > 0 ? `e-${src}-p${port}-${tgt}` : `e-${src}-${tgt}`,
          source_node_id: src,
          target_node_id: tgt,
        };
      });
    // New node/edge objects are brand new, so both mirrors can share them.
    const append = (doc: Record<string, unknown>): Record<string, unknown> => ({
      ...doc,
      nodes: [...irGraph.getIrNodes(doc), ...cloned],
      edges: [...irGraph.getIrEdges(doc), ...clonedEdges],
    });
    const nextJson = append(s.workflowJson!);
    set({
      workflowJson: nextJson,
      workflowIr: append(s.workflowIr!),
      dirty: true,
      nodeCount: irGraph.getIrNodes(nextJson).length,
      connectionsCount: irGraph.countIrEdges(nextJson),
    });
    return cloned.map((n) => n.id as string);
  },

  addWorkflowConnection: (source: string, target: string, port = 0, portType: "main" | "error" | "tool" = "main") => {
    const s = get();
    if (source === target || !canEditIrGraph(s)) return;
    const next = irGraph.addIrEdge(s.workflowJson!, source, target, port, portType);
    if (next === s.workflowJson) return; // already wired
    set({
      workflowJson: next,
      workflowIr: irGraph.addIrEdge(s.workflowIr!, source, target, port, portType),
      dirty: true,
      connectionsCount: irGraph.countIrEdges(next),
    });
  },

  removeWorkflowConnection: (source: string, target: string, port?: number, portType?: "main" | "error" | "tool") => {
    const s = get();
    if (!canEditIrGraph(s)) return;
    const next = irGraph.removeIrEdge(s.workflowJson!, source, target, port, portType);
    if (next === s.workflowJson) return;
    set({
      workflowJson: next,
      workflowIr: irGraph.removeIrEdge(s.workflowIr!, source, target, port, portType),
      dirty: true,
      connectionsCount: irGraph.countIrEdges(next),
    });
  },

  revertEdits: () => {
    const snap = get().lastGeneratedJson;
    if (!snap) return;
    set({
      workflowJson: snap,
      // The canvas renders workflowIr — reset it too, or abandoned edits stay visible.
      ...(irGraph.isIrDocument(snap) ? { workflowIr: snap } : {}),
      dirty: false,
      nodeCount: workflowNodeCount(snap),
      connectionsCount: workflowConnectionCount(snap),
    });
  },

  beginDeployedEdit: () => {
    const wf = get().workflowJson;
    if (!wf) return;
    set({
      step: "preview",
      editorMode: "deployed",
      lastGeneratedJson: wf,
      dirty: false,
      stripReady: true,
    });
  },

  saveDeployedEdits: async (message?: string) => {
    const {
      workflowId,
      workflowJson,
      dirty,
      editBranch,
      lastGeneratedJson,
      baseVersionId,
    } = get();
    if (!workflowId || !workflowJson || !dirty) return;
    // `dirty` can be re-armed by a merge landing the same content in a different byte order — compare
    // canonically so a no-diff version is never committed.
    if (
      lastGeneratedJson &&
      irContentKey(workflowJson) === irContentKey(lastGeneratedJson)
    ) {
      set({ dirty: false });
      toast.info(
        "No changes to save",
        "The canvas already matches the latest version.",
      );
      return;
    }
    const onMain = editBranch === "main";
    set({ isLoading: true, error: null });

    let version: api.WorkflowVersionSummary;
    try {
      version = await api.commitVersion(workflowId, {
        workflow_json: workflowJson,
        branch: editBranch,
        // A head that advanced past this 409s (ADR 0034 B5) rather than forking or clobbering.
        base_version_id: baseVersionId ?? undefined,
        // The user's words win, then continue-from provenance; otherwise no message at all.
        commit_message:
          message?.trim() ||
          (get().editFromVersion
            ? `Continued from v${get().editFromVersion}`
            : undefined),
      });
    } catch (e) {
      set({ isLoading: false });
      // Branch moved: hand off to BranchMovedDialog. `dirty` stays set so the edits survive for the rebase.
      const moved = api.asBranchMoved(e);
      if (moved) {
        set({
          branchMoved: {
            currentHeadVersionId: moved.current_head_version_id,
            currentHeadVersionNumber: moved.current_head_version_number,
            baseVersionId: moved.base_version_id,
          },
        });
        return;
      }
      toast.error(
        "Couldn't save your edits",
        e instanceof Error ? e.message : undefined,
      );
      return;
    }

    warnBrokenRefs(version.ref_warnings);

    if (version.no_changes) {
      // The head already IS our content — sync the base to it so the NEXT edit commits against the true head.
      set({
        dirty: false,
        lastGeneratedJson: workflowJson,
        baseVersionId: version.id,
        isLoading: false,
      });
      toast.info(
        "No changes to save",
        `v${version.version_number} is already the latest.`,
      );
      return;
    }

    // Clear `dirty` here or a retry re-commits the same content as another version; advancing the base
    // keeps the next commit's guard on the true head (ADR 0034 B5).
    set({
      dirty: false,
      lastGeneratedJson: workflowJson,
      baseVersionId: version.id,
    });

    set({ isLoading: false, step: "execute", stripReady: false });
    if (!onMain) {
      toast.success(
        `v${version.version_number} saved on ${editBranch}`,
        "Committed to this branch — merge into main when it's ready to release.",
      );
    } else {
      toast.success(
        `v${version.version_number} saved on Sarati`,
        "Saved as the latest version — Publish it to make it live",
      );
    }
  },

  dismissBranchMoved: () => set({ branchMoved: null }),

  rebaseOntoHead: async () => {
    const { workflowId, editBranch, branchMoved, workflowJson, lastGeneratedJson } =
      get();
    if (!workflowId || !branchMoved || !workflowJson) return;
    set({ isLoading: true, error: null });

    let head: api.WorkflowVersionSummary | undefined;
    let merged: Record<string, unknown>;
    let conflicts: api.ComposerMergeConflict[];
    try {
      // Re-read the TRUE head: another commit may have landed since the 409, and merging onto anything
      // older 409s straight back.
      const resp = await api.listVersions(workflowId, editBranch);
      const versions = resp.versions ?? [];
      head = versions.length
        ? versions.reduce((a, b) =>
            b.version_number > a.version_number ? b : a,
          )
        : undefined;
      const theirs = head?.workflow_json;
      if (!head || !theirs || !Array.isArray((theirs as { nodes?: unknown[] }).nodes)) {
        throw new Error("The latest version has no editable graph to merge onto.");
      }
      // Three-way merge: base = the version we loaded from, ours = local edits, theirs = the moved-on
      // head. A same-field collision keeps OUR value (user-wins provisional).
      const base = lastGeneratedJson ?? theirs;
      ({ merged, conflicts } = await api.composeMerge(base, workflowJson, theirs));
    } catch (e) {
      set({ isLoading: false });
      toast.error(
        "Couldn't rebase onto the latest version",
        e instanceof Error ? e.message : undefined,
      );
      return; // leave the dialog open so the user can retry or discard
    }

    // Land on the fresh head: the moved-on doc is the new baseline and the base id advances, so the
    // re-commit's guard passes.
    set({
      baseVersionId: head.id,
      lastGeneratedJson: head.workflow_json,
      branchMoved: null,
      isLoading: false,
    });
    get().resumeDraftIr(merged);
    if (conflicts.length > 0) {
      toast.warning(
        "Merged onto the latest version",
        `Kept your value where it clashed (${conflicts.length} field${conflicts.length > 1 ? "s" : ""}). Review before you rely on it.`,
      );
    }
    // Re-commit against the fresh base; a no-op just clears dirty, a real diff mints the next version.
    await get().saveDeployedEdits();
  },

  discardAndLoadHead: async () => {
    const { workflowId, editBranch, branchMoved } = get();
    if (!workflowId || !branchMoved) return;
    // loadForEdit clears branchMoved only on success, so a failed reload leaves the dialog up to retry.
    await get().loadForEdit(workflowId, editBranch);
  },

  loadForEdit: async (
    workflowId: string,
    branch = "main",
    fromVersion?: number,
  ) => {
    set({ isLoading: true, error: null });
    try {
      const [detail, versionsResp] = await Promise.all([
        api.getWorkflow(workflowId),
        api.listVersions(workflowId, branch),
      ]);

      const versions = versionsResp.versions ?? [];
      if (versions.length === 0) {
        set({ isLoading: false });
        toast.error(
          "Nothing to edit yet",
          `This workflow has no committed version on ${branch}.`,
        );
        return false;
      }
      // Base edits on the branch HEAD; an explicit fromVersion bases the CONTENT on that old version
      // instead, but Save still appends a new head so history is never rewritten.
      const head = fromVersion
        ? versions.find((v) => v.version_number === fromVersion)
        : versions.reduce((a, b) =>
            b.version_number > a.version_number ? b : a,
          );
      if (!head) {
        set({ isLoading: false });
        toast.error(
          "Version not found",
          `v${fromVersion} doesn't exist on ${branch}.`,
        );
        return false;
      }
      const wfJson = head.workflow_json ?? null;
      if (!wfJson || !Array.isArray((wfJson as { nodes?: unknown[] }).nodes)) {
        set({ isLoading: false });
        toast.error(
          "Couldn't open the editor",
          "This version has no editable graph.",
        );
        return false;
      }

      set({
        workflowId,
        workflowName: detail.name,
        workflowJson: wfJson,
        // The canvas renders through workflowIr — mirror the head doc there so its wires draw.
        workflowIr: wfJson,
        lastGeneratedJson: wfJson,
        discoveredNodes: [],
        editorMode: "deployed",
        editBranch: branch,
        editFromVersion: fromVersion ?? null,
        // Always the branch head, even on continue-from-vN: the head is what a commit races against.
        baseVersionId:
          versions.reduce((a, b) =>
            b.version_number > a.version_number ? b : a,
          ).id ?? null,
        branchMoved: null,
        dirty: false,
        step: "preview",
        stripReady: true,
        nodeCount: workflowNodeCount(wfJson),
        connectionsCount: workflowConnectionCount(wfJson),
        isLoading: false,
        error: null,
        warning: null,
        history: emptyHistory(),
      });
      // The loaded head is the undo floor — undoing all edits returns here.
      primeHistoryBaseline(wfJson);
      return true;
    } catch (e) {
      set({ isLoading: false });
      toast.error(
        "Couldn't open the editor",
        e instanceof Error ? e.message : undefined,
      );
      return false;
    }
  },

  resumeDraftIr: (ir: Record<string, unknown>) => {
    // Dirty is a CONTENT claim, not a "this setter ran" claim — byte-order/position noise must never arm Save.
    const baseline = get().lastGeneratedJson;
    const dirty = baseline ? irContentKey(ir) !== irContentKey(baseline) : true;
    set({
      workflowJson: ir,
      workflowIr: irGraph.isIrDocument(ir) ? ir : null,
      dirty,
      nodeCount: workflowNodeCount(ir),
      connectionsCount: workflowConnectionCount(ir),
    });
  },

  // ─── View Actions ───

  goToDashboard: () => {
    const state = get();
    state.reset();
    set({ view: "dashboard" });
    state.fetchWorkflows();
  },

  // ─── Dashboard Actions ───

  fetchWorkflows: async () => {
    set({ dashboardLoading: true, dashboardError: null });
    try {
      const result = await api.listWorkflows({ limit: 50, offset: 0 });
      set({
        workflows: result.workflows,
        dashboardTotal: result.total,
        dashboardHasMore: result.has_more,
        dashboardOffset: result.offset + result.workflows.length,
        dashboardLoading: false,
      });
    } catch (e) {
      set({
        dashboardLoading: false,
        dashboardError:
          e instanceof Error ? e.message : "Failed to load workflows",
      });
    }
  },

  loadMoreWorkflows: async () => {
    const { dashboardLoadingMore, dashboardHasMore, dashboardOffset } = get();
    if (dashboardLoadingMore || !dashboardHasMore) return;
    set({ dashboardLoadingMore: true, dashboardError: null });
    try {
      const result = await api.listWorkflows({
        limit: 50,
        offset: dashboardOffset,
      });
      set((s) => ({
        workflows: [...s.workflows, ...result.workflows],
        dashboardTotal: result.total,
        dashboardHasMore: result.has_more,
        dashboardOffset: result.offset + result.workflows.length,
        dashboardLoadingMore: false,
      }));
    } catch (e) {
      set({
        dashboardLoadingMore: false,
        dashboardError:
          e instanceof Error ? e.message : "Failed to load more workflows",
      });
    }
  },

  deleteWorkflow: async (id: string) => {
    try {
      await api.deleteWorkflow(id);
      set((s) => ({
        workflows: s.workflows.filter((w) => w.id !== id),
        dashboardTotal: Math.max(0, s.dashboardTotal - 1),
      }));
    } catch (e) {
      set({
        dashboardError:
          e instanceof Error ? e.message : "Failed to delete workflow",
      });
    }
  },

  selectWorkflow: (id: string | null) => {
    set({ selectedWorkflowId: id, selectedConfig: null });
  },

  fetchWorkflowConfig: async (id: string) => {
    try {
      const config = await api.getWorkflowConfig(id);
      set({ selectedConfig: config });
      return config;
    } catch {
      return null;
    }
  },

  executeFromDashboard: async (
    id: string,
    inputs?: Record<string, unknown>,
  ) => {
    try {
      const result = await api.executeWorkflowWithInputs(id, inputs);
      return result.execution_id;
    } catch {
      return null;
    }
  },

  clearHighlight: () => set({ highlightedWorkflowId: null }),
}));

// Persist the draft slice on every store change (debounced — workflowJson can be large).
let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
useWorkflow.subscribe((state) => {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => saveDraft(state), 400);
});

// Commit a canvas-history snapshot when the document's CONTENT settles; debounced so a burst of edits
// collapses into one undo step, and deduped by irContentKey so layout-only moves create none.
useWorkflow.subscribe((state) => {
  if (!irGraph.isIrDocument(state.workflowJson)) return;
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistorySnapshot, HISTORY_COMMIT_MS);
});

// Prime from a refresh-resumed draft so the first edit after a reload is undoable; history itself is
// session-ephemeral and never serialised.
primeHistoryBaseline(useWorkflow.getState().workflowJson);
