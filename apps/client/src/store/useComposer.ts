import { create } from "zustand";
import * as agent from "@/api/agent";
import * as api from "@/api/client";
import { activeConnections, matchingConnections } from "@/lib/connections";
import { composeMerge, type ComposerMergeConflict } from "@/api/client";
import { irCanvasKey, irContentKey } from "@/lib/irCompare";
import { useWorkflow } from "@/store/useWorkflow";

/**
 * Composer conversation state — ONE store, because ComposerBar and the canvas node badges render the
 * same records. The session id lives in sessionStorage as the same-tab fast path; attach also sends the
 * workflow id (or the scratch flag) so the server can resolve the durable thread by identity.
 */

export interface QuestionState {
  questionId: string;
  question: string;
  options: string[];
  nodeId?: string;
  answer?: string;
  timedOut?: boolean;
  submitting?: boolean;
}

export interface StepResult {
  status: "passed" | "failed";
  summary?: string;
}

/** A step waiting on an app connection (A4) — rendered as Connect chips on both surfaces. */
export interface ConnectionNeed {
  provider: string;
  providerLabel: string;
}

export type ThreadEntry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "brief"; brief: agent.BriefData }
  | { id: number; kind: "question"; questionId: string }
  | { id: number; kind: "run"; status: "passed" | "failed"; text: string };

export type OfferChoice = "live" | "tweak";

interface ComposerStore {
  sessionId?: string;
  streaming: boolean;
  failure: string | null;
  thread: ThreadEntry[];
  /** questionId → live question state (thread chip + canvas chip read the same record). */
  questions: Record<string, QuestionState>;
  /** nodeId → assumption badge texts (draft-scoped, amber on the canvas). */
  assumptions: Record<string, string[]>;
  /** nodeId → latest test/run outcome (draft-scoped bead on the canvas). */
  stepResults: Record<string, StepResult>;
  /** nodeId → the app connection that step is waiting on (Connect chips). */
  connectionNeeds: Record<string, ConnectionNeed>;
  /** A canvas badge tap lands here; ComposerBar consumes it into the input. */
  prefill: string | null;
  /** The agent offered to save (A3) — render the accept chips. */
  offerPending: boolean;
  /** An accept-offer save (existing) or create (new) is in flight. */
  accepting: boolean;

  send: (message: string, workflowId?: string) => Promise<void>;
  /** An accept-chip tap: drive the EXISTING save/publish flows, tell the session the outcome. */
  acceptOffer: (choice: OfferChoice, workflowId?: string) => Promise<void>;
  /** Reattach to a stored session after a refresh — replays the thread, rejoins a live turn. */
  attach: (workflowId?: string) => Promise<void>;
  /** Clear this conversation: durable thread + live session + local state. */
  clearThread: (workflowId?: string) => Promise<void>;
  answer: (questionId: string, answer: string) => Promise<void>;
  /** A Connect chip finished its sign-in: clear the asks and tell the agent to re-test. */
  notifyConnected: (provider: string, providerLabel: string) => Promise<void>;
  requestPrefill: (text: string) => void;
  consumePrefill: () => string | null;
  reset: () => void;
}

let nextEntryId = 1;
let controller: AbortController | null = null;
/** The workflow the conversation is scoped to — lets canvas surfaces send without a prop chain. */
let activeWorkflowId: string | undefined;
/** Re-key the live session onto a just-created workflow id, so the conversation follows it to the editor. */
export function adoptSessionForWorkflow(workflowId: string): void {
  const sid = useComposer.getState().sessionId;
  if (sid) rememberSession(workflowId, sid);
  activeWorkflowId = workflowId;
}

/** The canvas at turn start — the three-way merge base for co-editing. */
let turnBaseIr: Record<string, unknown> | null = null;
/** Same-field collisions found while merging; relayed to the agent at turn end. */
let pendingConflicts: ComposerMergeConflict[] = [];
let tokenTimer: ReturnType<typeof setInterval> | null = null;

function startTokenRefresh(sessionId: string): void {
  stopTokenRefresh();
  // Clerk JWTs rotate ~every minute, so an unattended build would otherwise outlive its token.
  tokenTimer = setInterval(() => void agent.refreshSessionToken(sessionId), 45_000);
}

function stopTokenRefresh(): void {
  if (tokenTimer) {
    clearInterval(tokenTimer);
    tokenTimer = null;
  }
}

function storageKey(workflowId?: string): string {
  return `composer.session.${workflowId ?? "new"}`;
}

function storedSession(workflowId?: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(workflowId));
  } catch {
    return null;
  }
}

function rememberSession(workflowId: string | undefined, sessionId: string): void {
  try {
    sessionStorage.setItem(storageKey(workflowId), sessionId);
  } catch {
    // Storage may be unavailable (private mode) — reattach just won't work.
  }
}

function forgetSession(workflowId?: string): void {
  try {
    sessionStorage.removeItem(storageKey(workflowId));
  } catch {
    // ignore
  }
}

export const useComposer = create<ComposerStore>((set, get) => {
  /** The one reducer both live streaming and attach-replay run through. */
  const handleEvent = async (evt: agent.SequencedComposerEvent, workflowId?: string): Promise<void> => {
    if (evt.event === "session") {
      set({ sessionId: evt.data.session_id });
      rememberSession(workflowId, evt.data.session_id);
      // The server may hand back a NEW id after a restart-driven retry — keep the refresh on the live one.
      startTokenRefresh(evt.data.session_id);
    } else if (evt.event === "user_message") {
      // Replay only; supersedes a standing offer exactly as send() does, so replay ends in the same state.
      set((s) => ({
        offerPending: false,
        thread: [...s.thread, { id: nextEntryId++, kind: "user", text: evt.data.text }],
      }));
    } else if (evt.event === "assistant_text") {
      set((s) => {
        const last = s.thread[s.thread.length - 1];
        if (last?.kind === "text") {
          const updated = { ...last, text: last.text + evt.data.text };
          return { thread: [...s.thread.slice(0, -1), updated] };
        }
        const text = evt.data.text.replace(/^\n+/, "");
        if (!text) return {};
        return { thread: [...s.thread, { id: nextEntryId++, kind: "text", text }] };
      });
    } else if (evt.event === "brief") {
      // A re-emitted brief REPLACES the card (the plan evolved).
      set((s) => {
        let idx = -1;
        for (let i = s.thread.length - 1; i >= 0; i -= 1) {
          if (s.thread[i]!.kind === "brief") {
            idx = i;
            break;
          }
        }
        if (idx >= 0) {
          const updated = [...s.thread];
          updated[idx] = { ...(updated[idx] as { id: number; kind: "brief" }), brief: evt.data };
          return { thread: updated };
        }
        return { thread: [...s.thread, { id: nextEntryId++, kind: "brief", brief: evt.data }] };
      });
    } else if (evt.event === "question") {
      const q: QuestionState = {
        questionId: evt.data.question_id,
        question: evt.data.question,
        options: evt.data.options,
        nodeId: evt.data.node_id,
      };
      set((s) => ({
        questions: { ...s.questions, [q.questionId]: q },
        thread: [...s.thread, { id: nextEntryId++, kind: "question", questionId: q.questionId }],
      }));
    } else if (evt.event === "question_resolved") {
      set((s) => {
        const q = s.questions[evt.data.question_id];
        if (!q) return {};
        return {
          questions: {
            ...s.questions,
            [q.questionId]: {
              ...q,
              answer: evt.data.answer,
              timedOut: evt.data.timed_out,
              submitting: false,
            },
          },
        };
      });
    } else if (evt.event === "assumption") {
      set((s) => {
        const existing = s.assumptions[evt.data.node_id] ?? [];
        if (existing.includes(evt.data.text)) return {};
        return { assumptions: { ...s.assumptions, [evt.data.node_id]: [...existing, evt.data.text] } };
      });
    } else if (evt.event === "step_result") {
      set((s) => {
        const next: Partial<ComposerStore> = {
          stepResults: {
            ...s.stepResults,
            [evt.data.node_id]: { status: evt.data.status, summary: evt.data.summary },
          },
        };
        // A green re-test clears the step's standing Connect ask (mirrors the server snapshot fold).
        if (evt.data.status === "passed" && s.connectionNeeds[evt.data.node_id]) {
          const remaining = { ...s.connectionNeeds };
          delete remaining[evt.data.node_id];
          next.connectionNeeds = remaining;
        }
        return next;
      });
    } else if (evt.event === "connection_needed") {
      set((s) => ({
        connectionNeeds: {
          ...s.connectionNeeds,
          [evt.data.node_id]: { provider: evt.data.provider, providerLabel: evt.data.provider_label },
        },
      }));
    } else if (evt.event === "run_result") {
      const passed = evt.data.status === "passed";
      set((s) => ({
        thread: [
          ...s.thread,
          {
            id: nextEntryId++,
            kind: "run",
            status: evt.data.status,
            text: passed ? "Everything ran clean." : "A step hit a problem during the test run.",
          },
        ],
      }));
    } else if (evt.event === "op_applied") {
      // The agent's doc lands THROUGH a three-way merge, so mid-turn user edits survive.
      const ours = useWorkflow.getState().workflowJson;
      const base = turnBaseIr;
      // "Untouched" comes from the oracle, never a byte-compare (constitution #4). Canvas key, not
      // content key — a pure node move IS user work and must take the merge path.
      if (!base || !ours || irCanvasKey(ours) === irCanvasKey(base)) {
        useWorkflow.getState().resumeDraftIr(evt.data.ir);
        // Advance the base to the agent's own doc each batch, so its add-then-fill never re-diffs as
        // phantom user edits and a later batch can't read as a revert.
        turnBaseIr = JSON.parse(JSON.stringify(evt.data.ir)) as Record<string, unknown>;
      } else {
        try {
          const { merged, conflicts } = await composeMerge(base, ours, evt.data.ir);
          useWorkflow.getState().resumeDraftIr(merged);
          // A canvas equal to the committed baseline is NOT dirty — a re-armed Save would mint a
          // no-diff version.
          const wf = useWorkflow.getState();
          if (wf.workflowId && wf.lastGeneratedJson && irContentKey(merged) === irContentKey(wf.lastGeneratedJson)) {
            useWorkflow.setState({ dirty: false });
          }
          turnBaseIr = JSON.parse(JSON.stringify(evt.data.ir)) as Record<string, unknown>;
          for (const c of conflicts) {
            if (!pendingConflicts.some((p) => p.node_id === c.node_id && p.field_path === c.field_path)) {
              pendingConflicts.push(c);
            }
          }
        } catch {
          // Reconciliation unavailable — leave the user's canvas alone rather than clobber it.
        }
      }
    } else if (evt.event === "offer") {
      set({ offerPending: true });
    } else if (evt.event === "snapshot") {
      // Reattach hydration: state beats history (long sessions).
      const snap = evt.data;
      const thread: ThreadEntry[] = [];
      const questions: Record<string, QuestionState> = {};
      if (snap.brief) thread.push({ id: nextEntryId++, kind: "brief", brief: snap.brief });
      for (const q of snap.questions) {
        questions[q.question_id] = {
          questionId: q.question_id,
          question: q.question,
          options: q.options,
          nodeId: q.node_id,
          answer: q.answer,
          timedOut: q.timed_out,
        };
        thread.push({ id: nextEntryId++, kind: "question", questionId: q.question_id });
      }
      const assumptions: Record<string, string[]> = {};
      for (const a of snap.assumptions) {
        assumptions[a.node_id] = [...(assumptions[a.node_id] ?? []), a.text];
      }
      const stepResults: Record<string, StepResult> = {};
      for (const r of snap.step_results) {
        stepResults[r.node_id] = { status: r.status, summary: r.summary };
      }
      const connectionNeeds: Record<string, ConnectionNeed> = {};
      for (const c of snap.connection_needs ?? []) {
        connectionNeeds[c.node_id] = { provider: c.provider, providerLabel: c.provider_label };
      }
      set({ thread, questions, assumptions, stepResults, connectionNeeds, offerPending: snap.offer_pending });
      if (snap.ir) {
        useWorkflow.getState().resumeDraftIr(snap.ir);
        // A mid-turn refresh loses the original base; the agent's current draft becomes it.
        turnBaseIr = snap.ir;
      }
    } else if (evt.event === "error") {
      set({ failure: evt.data.message });
    }
  };

  // Stream one turn into the store. Returns true iff the session died, having forgotten the dead id so
  // `send` can retry ONCE; streaming/controller cleanup is the CALLER's job, so a retry stays one turn.
  const streamTurn = async (
    message: string,
    canvas: Record<string, unknown> | null,
    mine: AbortController,
    workflowId?: string,
  ): Promise<boolean> => {
    try {
      for await (const evt of agent.composerStream(
        { message, sessionId: get().sessionId, workflowId, ir: canvas },
        mine.signal,
      )) {
        // A dead session is recoverable, not a user error — drop the stale id and signal a retry.
        if (evt.event === "error" && /unknown or expired session/i.test(evt.data.message)) {
          forgetSession(workflowId);
          set({ sessionId: undefined });
          return true;
        }
        await handleEvent(evt, workflowId);
      }
    } catch (e) {
      if (!mine.signal.aborted) {
        set({ failure: e instanceof Error ? e.message : "The composer is unreachable." });
      }
    }
    return false;
  };

  return {
    sessionId: undefined,
    streaming: false,
    failure: null,
    thread: [],
    questions: {},
    assumptions: {},
    stepResults: {},
    connectionNeeds: {},
    prefill: null,
    offerPending: false,
    accepting: false,

    send: async (message: string, workflowId?: string) => {
      const trimmed = message.trim();
      if (!trimmed || get().streaming) return;
      activeWorkflowId = workflowId ?? activeWorkflowId;
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      const canvas = useWorkflow.getState().workflowJson;
      // The merge base: what BOTH sides start from this turn.
      turnBaseIr = canvas ? (JSON.parse(JSON.stringify(canvas)) as Record<string, unknown>) : null;
      set((s) => ({
        streaming: true,
        failure: null,
        offerPending: false, // a new message supersedes a standing offer
        thread: [...s.thread, { id: nextEntryId++, kind: "user", text: trimmed }],
      }));
      const sid = get().sessionId;
      if (sid) startTokenRefresh(sid);
      try {
        // An agent-service restart drops the in-memory session — retry ONCE on a fresh one.
        const dead = await streamTurn(trimmed, canvas, mine, workflowId);
        if (dead && !mine.signal.aborted) {
          await streamTurn(trimmed, canvas, mine, workflowId);
        }
      } finally {
        stopTokenRefresh();
        // Only the ACTIVE stream may clear the flag; a superseded one finishes late and must die silently.
        if (controller === mine) {
          controller = null;
          set({ streaming: false });
        }
      }
      await relayConflicts(workflowId);
    },

    acceptOffer: async (choice: OfferChoice, workflowId?: string) => {
      set({ offerPending: false });
      if (choice === "tweak") return;
      // Accept = SAVE only: the composer commits versions but NEVER moves a live pointer (ADR 0032).
      set({ accepting: true });
      try {
        if (!workflowId) {
          // Creating isn't promoting — there's no existing pointer to move — so a composer-first
          // workflow may still be brought into being here.
          await useWorkflow.getState().deploy();
          const { workflowId: createdId, error: deployError } = useWorkflow.getState();
          if (deployError || !createdId) {
            set({ failure: deployError ?? "Couldn't create the workflow." });
            return;
          }
          activeWorkflowId = createdId;
          forgetSession(undefined);
          const sid = get().sessionId;
          if (sid) rememberSession(createdId, sid);
          await get().send("Created it.", createdId);
          return;
        }
        // Save ≠ Live: commit a new version, never publish.
        await useWorkflow.getState().saveDeployedEdits();
        // BranchMovedDialog now owns the resolution — bail quietly rather than stack a failure on it.
        if (useWorkflow.getState().branchMoved) return;
        if (useWorkflow.getState().dirty) {
          set({ failure: "Couldn't save — try Save in the header." });
          return;
        }
        await get().send("Saved a new version. It won't go live until you publish it from the overview.", workflowId);
      } catch (e) {
        set({ failure: e instanceof Error ? e.message : "Couldn't save." });
      } finally {
        set({ accepting: false });
      }
    },

    attach: async (workflowId?: string) => {
      activeWorkflowId = workflowId ?? activeWorkflowId;
      if (get().streaming) return;
      // The stored id is only a fast path — without one the server resolves the thread by identity.
      const sessionId = storedSession(workflowId) ?? undefined;
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      set({ streaming: true, failure: null, sessionId });
      if (sessionId) startTokenRefresh(sessionId);
      try {
        for await (const evt of agent.composerAttach(
          { sessionId, workflowId, scratch: !workflowId, lastEventSeq: 0 },
          mine.signal,
        )) {
          // A dead session isn't an error to show — just start fresh next send.
          if (evt.event === "error" && /unknown or expired session/i.test(evt.data.message)) {
            forgetSession(workflowId);
            set({ sessionId: undefined });
            return;
          }
          // The server may resolve a DIFFERENT session — keep the token refresh on the live one.
          if (evt.event === "session" && evt.data.session_id !== sessionId) {
            startTokenRefresh(evt.data.session_id);
          }
          await handleEvent(evt, workflowId);
        }
      } catch (e) {
        if (!mine.signal.aborted) {
          set({ failure: e instanceof Error ? e.message : "The composer is unreachable." });
        }
      } finally {
        stopTokenRefresh();
        if (controller === mine) {
          controller = null;
          set({ streaming: false });
        }
      }
      await relayConflicts(workflowId);
    },

    answer: async (questionId: string, answerText: string) => {
      const { sessionId, questions } = get();
      const q = questions[questionId];
      const trimmed = answerText.trim();
      if (!sessionId || !q || q.answer !== undefined || q.submitting || !trimmed) return;
      set((s) => ({
        questions: { ...s.questions, [questionId]: { ...q, submitting: true } },
      }));
      try {
        await agent.answerQuestion({ sessionId, questionId, answer: trimmed });
        // The open stream's question_resolved clears `submitting` and stamps the answer.
      } catch (e) {
        set((s) => ({
          questions: { ...s.questions, [questionId]: { ...s.questions[questionId]!, submitting: false } },
          failure: e instanceof Error ? e.message : "Couldn't send the answer.",
        }));
      }
    },

    notifyConnected: async (provider: string, providerLabel: string) => {
      // BIND the fresh account into every waiting step first, or their connectionId stays empty and runs
      // fail. Newest active match wins — it's the one that just landed.
      const waitingNodes = Object.entries(get().connectionNeeds)
        .filter(([, need]) => need.provider === provider)
        .map(([nodeId]) => nodeId);
      if (waitingNodes.length > 0) {
        try {
          const { connections } = await api.listConnections();
          const match = matchingConnections(activeConnections(connections), provider).sort((a, b) =>
            (b.created_at ?? "").localeCompare(a.created_at ?? ""),
          )[0];
          if (match) {
            for (const nodeId of waitingNodes) {
              const doc = useWorkflow.getState().workflowJson as {
                nodes?: { id: string; parameters?: Record<string, unknown> }[];
              } | null;
              const live = doc?.nodes?.find((n) => n.id === nodeId);
              if (!live) continue;
              const p = live.parameters ?? {};
              if (typeof p.connectionId === "string" && p.connectionId !== "") continue;
              // Silent capture, not a user edit — the doc carries it into the next save either way.
              useWorkflow.getState().updateIrNode(nodeId, { parameters: { ...p, connectionId: match.id } }, { markDirty: false });
            }
          }
        } catch {
          // Binding is best-effort — the agent's doctrine covers the miss.
        }
      }
      // One connection serves every step on that provider — clear them all.
      set((s) => {
        const remaining: Record<string, ConnectionNeed> = {};
        for (const [nodeId, need] of Object.entries(s.connectionNeeds)) {
          if (need.provider !== provider) remaining[nodeId] = need;
        }
        return { connectionNeeds: remaining };
      });
      // Tell the agent so it re-tests the step; mid-turn the send guard drops this.
      if (!get().streaming) {
        await get().send(
          `(canvas note) ${providerLabel} is now connected — re-test the step that needed it.`,
          activeWorkflowId,
        );
      }
    },

    requestPrefill: (text: string) => set({ prefill: text }),
    consumePrefill: () => {
      const value = get().prefill;
      if (value !== null) set({ prefill: null });
      return value;
    },

    clearThread: async (workflowId?: string) => {
      try {
        await agent.composerClear(workflowId ? { workflowId } : { scratch: true });
      } catch {
        // Best effort — the local reset below always happens.
      }
      forgetSession(workflowId);
      get().reset();
    },

    reset: () => {
      // In-memory only — the stored session id survives so a refresh or round-trip still reattaches.
      controller?.abort();
      controller = null;
      stopTokenRefresh();
      turnBaseIr = null;
      pendingConflicts = [];
      set({
        sessionId: undefined,
        streaming: false,
        failure: null,
        thread: [],
        questions: {},
        assumptions: {},
        stepResults: {},
        connectionNeeds: {},
        prefill: null,
        offerPending: false,
        accepting: false,
      });
    },
  };

  /** Send the turn's same-field collisions back to the agent as ONE labelled canvas note. */
  async function relayConflicts(workflowId?: string): Promise<void> {
    if (pendingConflicts.length === 0 || get().streaming) return;
    const conflicts = pendingConflicts;
    pendingConflicts = [];
    const lines = conflicts.map((c) =>
      c.kind === "field"
        ? `on step "${c.node_name || c.node_id}" (${c.field_path ?? "field"}) I set ${JSON.stringify(c.ours)} while you set ${JSON.stringify(c.theirs)}`
        : `you removed step "${c.node_name || c.node_id}" but I had edited it (I kept it)`,
    );
    await get().send(
      `(canvas note) While you were building I made my own edits. We collided: ${lines.join("; ")}. My values are on the canvas — ask me which to keep where we disagree.`,
      workflowId,
    );
  }
});

/** The one unanswered question pinned to this node, if any (canvas chip). */
export function pendingQuestionFor(
  questions: Record<string, QuestionState>,
  nodeId: string,
): QuestionState | null {
  for (const q of Object.values(questions)) {
    if (q.nodeId === nodeId && q.answer === undefined) return q;
  }
  return null;
}
