// agent-service (:8010) client — the composer's SSE streams over fetch+ReadableStream, since EventSource
// can't POST. Every request carries the Clerk JWT; every frame carries a seq (`id:` line) = the replay key.

import { getAuthToken } from "@/api/client";
import { agentBaseUrl } from "@/lib/config";

// Resolved in @/lib/config, which fails a production build when NEXT_PUBLIC_AGENT_URL is unset.
const AGENT_BASE = agentBaseUrl + "/api";

/** Why the composer is off. `unreachable` is ours — the others are the service's own reasons. */
export type ComposerDisabledReason =
  | "anthropic_api_key_missing"
  | "caller_auth_unconfigured"
  | "unreachable";

export interface ComposerAvailability {
  available: boolean;
  reason?: ComposerDisabledReason;
  message?: string;
  docs?: string;
}

const UNREACHABLE: ComposerAvailability = {
  available: false,
  reason: "unreachable",
  message: "The AI composer service isn't reachable from here.",
};

/**
 * The capability probe, read once before any composer entry point renders.
 *
 * Deliberately unauthenticated and non-throwing: it runs before the app knows
 * whether it has a token, and EVERY failure mode means the same thing to the
 * UI — no composer. It also cannot reuse `/api/health`: behind the self-host
 * proxy only `/api/composer/*` routes to agent-service, so `/api/health` would
 * be answered by workflow-service with a confident, wrong "ok".
 *
 * Anything that isn't a 200 `{"status":"ok"}` counts as unavailable, which is
 * what lets the service be dropped from the stack entirely (proxy 502, HTML
 * error body, DNS failure) without the client needing to know.
 */
export async function composerStatus(signal?: AbortSignal): Promise<ComposerAvailability> {
  let res: Response;
  try {
    res = await fetch(`${AGENT_BASE}/composer/status`, { signal });
  } catch {
    return UNREACHABLE;
  }
  if (!res.ok) return UNREACHABLE;

  const body = (await res.json().catch(() => null)) as {
    status?: string;
    reason?: ComposerDisabledReason;
    message?: string;
    docs?: string;
  } | null;
  if (!body) return UNREACHABLE;
  if (body.status === "ok") return { available: true };
  return {
    available: false,
    reason: body.reason ?? "unreachable",
    message: body.message ?? UNREACHABLE.message,
    docs: body.docs,
  };
}

export interface BriefData {
  goal: string;
  trigger: string;
  steps: string[];
  needs: string[];
}

export type ComposerStreamEvent =
  | { event: "session"; data: { session_id: string } }
  // Attach replay only — live turns never send this; the sender renders its own message optimistically.
  | { event: "user_message"; data: { text: string } }
  | { event: "assistant_text"; data: { text: string } }
  | { event: "brief"; data: BriefData }
  | {
      event: "question";
      data: { question_id: string; question: string; options: string[]; node_id?: string };
    }
  | { event: "question_resolved"; data: { question_id: string; answer: string; timed_out?: boolean } }
  | { event: "assumption"; data: { node_id: string; text: string } }
  | {
      event: "connection_needed";
      data: { node_id: string; provider: string; provider_label: string };
    }
  | { event: "offer"; data: { offer_id: string } }
  | { event: "snapshot"; data: SessionSnapshot }
  | {
      event: "step_result";
      data: { node_id: string; status: "passed" | "failed"; summary?: string };
    }
  | {
      event: "run_result";
      data: { status: "passed" | "failed"; run_id?: string; failed_node_id?: string };
    }
  | { event: "op_applied"; data: { ops: Record<string, unknown>[]; ir: Record<string, unknown> } }
  | {
      event: "done";
      data: { session_id: string; duration_ms: number; num_turns?: number; total_cost_usd?: number };
    }
  | { event: "error"; data: { message: string } };

/** The reattach state snapshot (attach only) — everything the surfaces need. */
export interface SessionSnapshot {
  brief: BriefData | null;
  questions: Array<{
    question_id: string;
    question: string;
    options: string[];
    node_id?: string;
    answer?: string;
    timed_out?: boolean;
  }>;
  assumptions: Array<{ node_id: string; text: string }>;
  step_results: Array<{ node_id: string; status: "passed" | "failed"; summary?: string }>;
  connection_needs: Array<{ node_id: string; provider: string; provider_label: string }>;
  ir: Record<string, unknown> | null;
  offer_pending: boolean;
  busy: boolean;
}

/** Every frame carries its per-session seq (the SSE `id:` line). */
export type SequencedComposerEvent = ComposerStreamEvent & { seq: number };

export interface ComposerStreamParams {
  message: string;
  sessionId?: string;
  workflowId?: string;
  /** The current canvas document — sent every message so manual edits win. */
  ir?: Record<string, unknown> | null;
  /** Where the panel is docked this message (default: editor). */
  surface?: "editor" | "overview";
}

/** POSTs to the composer and yields sequenced SSE events as they arrive. */
export function composerStream(
  params: ComposerStreamParams,
  signal?: AbortSignal,
): AsyncGenerator<SequencedComposerEvent> {
  return sse(`${AGENT_BASE}/composer/stream`, {
    message: params.message,
    session_id: params.sessionId,
    workflow_id: params.workflowId,
    ir: params.ir ?? undefined,
    surface: params.surface,
  }, signal);
}

/** Clear the caller's conversation for a workflow (or the pre-save scratch thread). */
export async function composerClear(opts: { workflowId?: string; scratch?: boolean }): Promise<{ cleared: boolean }> {
  const token = await getAuthToken();
  const res = await fetch(`${AGENT_BASE}/composer/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ workflow_id: opts.workflowId, scratch: opts.scratch === true }),
  });
  if (!res.ok) throw new Error(`clear failed (${res.status})`);
  return (await res.json()) as { cleared: boolean };
}

/** Reattach a thread (by session id, or by identity) and replay its transcript after `lastEventSeq`. */
export function composerAttach(
  params: { sessionId?: string; workflowId?: string; scratch?: boolean; lastEventSeq?: number },
  signal?: AbortSignal,
): AsyncGenerator<SequencedComposerEvent> {
  return sse(`${AGENT_BASE}/composer/attach`, {
    session_id: params.sessionId,
    workflow_id: params.workflowId,
    scratch: params.scratch || undefined,
    last_event_seq: params.lastEventSeq ?? 0,
  }, signal);
}

async function* sse(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<SequencedComposerEvent> {
  const token = await getAuthToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const parsed = (await res.json().catch(() => ({}))) as { message?: string; detail?: string };
    throw new Error(parsed.message ?? parsed.detail ?? `Composer error ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const evt = parseSseMessage(raw);
      if (evt) yield evt;
    }
  }
}

/** Long-turn token refresh: hand the session a fresh Clerk JWT while a turn streams. */
export async function refreshSessionToken(sessionId: string): Promise<void> {
  const token = await getAuthToken();
  if (!token) return;
  await fetch(`${AGENT_BASE}/composer/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {
    // Best effort — the next /answer or /stream refreshes it anyway.
  });
}

/** Resolve a pending clarifying question (the paused turn continues on its stream). */
export async function answerQuestion(params: {
  sessionId: string;
  questionId: string;
  answer: string;
}): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${AGENT_BASE}/composer/answer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      session_id: params.sessionId,
      question_id: params.questionId,
      answer: params.answer,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Answer failed (${res.status})`);
  }
}

function parseSseMessage(raw: string): SequencedComposerEvent | null {
  let event = "message";
  let seq = 0;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) seq = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as ComposerStreamEvent["data"];
    return { event, data, seq } as SequencedComposerEvent;
  } catch {
    return null;
  }
}
