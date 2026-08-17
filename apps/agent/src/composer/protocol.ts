/**
 * The composer wire protocol — what the editor's SSE stream carries. Mirrors
 * the client's existing fetch+ReadableStream SSE parsing (generateWorkflowStream):
 * `event:` names one of these, `data:` is the JSON payload.
 */

/**
 * A WorkflowIR document as workflow-service returns it. agent-service treats
 * it as opaque pass-through state — apply-ops owns its shape and validation.
 */
export type WorkflowIr = Record<string, unknown>;

/** One graph operation (wire shape owned by workflow-service's apply-ops). */
export type ComposeOp = Record<string, unknown>;

/** The agent's plan card (A1) — re-emitted when the plan evolves; the client replaces the card. */
export interface BriefData {
  /** A short list-friendly workflow name ("Hacker News mentions → Slack") — the unrenamed default. */
  name: string;
  goal: string;
  trigger: string;
  steps: string[];
  /** What the agent still needs to know, in plain words ("Which channel?"). */
  needs: string[];
}

/** A clarifying question (A1). The turn PAUSES until POST /api/composer/answer or the timeout. */
export interface QuestionData {
  question_id: string;
  question: string;
  /** 2–4 tappable options; free-text is always allowed too. */
  options: string[];
  /** When set, the client also pins the question to this canvas node. */
  node_id?: string;
}

export type ComposerEvent =
  | { event: 'session'; data: { session_id: string } }
  // The user's own message, recorded for durable replay only: it is buffered
  // and persisted but NEVER pushed to the live stream (the sender renders its
  // message optimistically) — attach replay is how it reaches a client.
  | { event: 'user_message'; data: { text: string } }
  | { event: 'assistant_text'; data: { text: string } }
  | { event: 'op_applied'; data: { ops: ComposeOp[]; ir: WorkflowIr } }
  | { event: 'brief'; data: BriefData }
  | { event: 'question'; data: QuestionData }
  | {
      event: 'question_resolved';
      data: { question_id: string; answer: string; timed_out?: boolean };
    }
  | { event: 'assumption'; data: { node_id: string; text: string } }
  // A3 accept path: the agent offers the next step; the client renders the
  // fixed chips ("Save and turn on" / "Save as a draft" / "Keep tweaking").
  | { event: 'offer'; data: { offer_id: string } }
  // A4: a step's provider has no connection — the client renders a targeted
  // "Connect <Provider>" chip that opens the EXISTING connect flow.
  | {
      event: 'connection_needed';
      data: { node_id: string; provider: string; provider_label: string };
    }
  // A2 test loop: one bead per step, one line per run.
  | { event: 'step_result'; data: { node_id: string; status: 'passed' | 'failed'; summary?: string } }
  | {
      event: 'run_result';
      data: { status: 'passed' | 'failed'; run_id?: string; failed_node_id?: string };
    }
  | {
      event: 'done';
      data: { session_id: string; duration_ms: number; num_turns?: number; total_cost_usd?: number };
    }
  | { event: 'error'; data: { message: string } };

/**
 * Every event a session emits carries a per-session monotonically increasing
 * seq (the SSE `id:` line). POST /api/composer/attach either replays the
 * gap-free tail after `last_event_seq`, or — when the gap can't be bridged
 * (fresh page, ring buffer rolled) — sends ONE `snapshot` event with the
 * session's current state, then continues live.
 */
export type SequencedComposerEvent = ComposerEvent & { seq: number };

/** The reattach state snapshot: everything the client needs to rebuild its surfaces. */
export interface SessionSnapshot {
  brief: BriefData | null;
  questions: Array<QuestionData & { answer?: string; timed_out?: boolean }>;
  assumptions: Array<{ node_id: string; text: string }>;
  step_results: Array<{ node_id: string; status: 'passed' | 'failed'; summary?: string }>;
  connection_needs: Array<{ node_id: string; provider: string; provider_label: string }>;
  ir: WorkflowIr | null;
  offer_pending: boolean;
  busy: boolean;
}

export type AttachEvent =
  SequencedComposerEvent | ({ event: 'snapshot'; data: SessionSnapshot } & { seq: number });
