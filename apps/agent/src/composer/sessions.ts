import { randomUUID } from 'node:crypto';

import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { EventChannel } from './event-channel';
import type {
  BriefData,
  ComposerEvent,
  QuestionData,
  SequencedComposerEvent,
  SessionSnapshot,
  WorkflowIr,
} from './protocol';

/**
 * In-memory composer sessions — the hot path (A0). One live turn per session.
 * Durability is layered on, not in: when a session is bound to a durable
 * thread (ThreadStore), every emitted event ALSO write-throughs to Postgres
 * and an attach can rebuild the session from that log after a restart/TTL.
 * The ring buffer, TTL sweep, and orphan grace are unchanged.
 */
export interface ComposerSession {
  readonly id: string;
  /** The Agent SDK's session id — set after the first turn, used for resume. */
  sdkSessionId: string | null;
  workflowId: string | null;
  /** The durable composer_threads row this session writes through to (null = memory-only). */
  threadId: string | null;
  /** The verified caller identity (Clerk `sub`) the thread is keyed by. */
  userKey: string | null;
  /** Write-through hook (armed when a thread is bound): every emitted event is persisted. */
  persist: ((event: SequencedComposerEvent) => void) | null;
  draftIr: WorkflowIr | null;
  busy: boolean;
  lastUsedAt: number;
  /** Monotonic per-session event counter (the SSE `id:` line). */
  seq: number;
  /** Ring buffer of every emitted event — the attach/replay source. */
  buffer: SequencedComposerEvent[];
  /** The one live SSE consumer (stream OR attach) — replaced on reconnect. */
  subscriber: EventChannel<SequencedComposerEvent> | null;
  /**
   * The caller's bearer token, refreshed on every /stream and /answer request
   * — tool calls execute against workflow-service AS THE USER. Clerk session
   * JWTs are short-lived, so the freshest one wins (an expiry mid-turn
   * surfaces as a friendly tool error; the next interaction refreshes it).
   */
  callerToken: string | null;
  /** Aborts the RUNNING turn — fired only when the orphan grace period expires. */
  turnAbort: AbortController | null;
  /** Pending orphan-abort timer (armed on disconnect, cleared on reattach). */
  orphanTimer: NodeJS.Timeout | null;
  /** Rolling state for the reattach snapshot (updated on every emit). */
  snapshot: MutableSnapshot;
  /** node id → failed-test count THIS turn (the two-fix bound; reset at turn start). */
  fixAttempts: Map<string, number>;
  /** The last run_result failure's node (run_draft's fix-bound check). */
  lastFailedNodeId: string | null;
}

interface MutableSnapshot {
  brief: BriefData | null;
  questions: Map<string, QuestionData & { answer?: string; timed_out?: boolean }>;
  assumptions: Array<{ node_id: string; text: string }>;
  stepResults: Map<string, { node_id: string; status: 'passed' | 'failed'; summary?: string }>;
  connectionNeeds: Map<string, { node_id: string; provider: string; provider_label: string }>;
  ir: WorkflowIr | null;
  offerPending: boolean;
}

/** The wire-shaped snapshot for POST /api/composer/attach. */
export function snapshotOf(session: ComposerSession): SessionSnapshot {
  return {
    brief: session.snapshot.brief,
    // Clone: fold mutates question entries in place (answer stamping) — a
    // snapshot must be a point-in-time copy, not a live view.
    questions: [...session.snapshot.questions.values()].map((q) => ({ ...q })),
    assumptions: [...session.snapshot.assumptions],
    step_results: [...session.snapshot.stepResults.values()],
    connection_needs: [...session.snapshot.connectionNeeds.values()],
    ir: session.draftIr,
    offer_pending: session.snapshot.offerPending,
    busy: session.busy,
  };
}

/** Fold an event into the rolling snapshot — the reattach source of truth. */
function foldIntoSnapshot(snapshot: MutableSnapshot, event: ComposerEvent): void {
  if (event.event === 'brief') {
    snapshot.brief = event.data;
  } else if (event.event === 'question') {
    snapshot.questions.set(event.data.question_id, { ...event.data });
  } else if (event.event === 'question_resolved') {
    const q = snapshot.questions.get(event.data.question_id);
    if (q) {
      q.answer = event.data.answer;
      if (event.data.timed_out) q.timed_out = true;
    }
  } else if (event.event === 'assumption') {
    if (!snapshot.assumptions.some((a) => a.node_id === event.data.node_id && a.text === event.data.text)) {
      snapshot.assumptions.push(event.data);
    }
  } else if (event.event === 'step_result') {
    snapshot.stepResults.set(event.data.node_id, { ...event.data });
    // A green re-test clears the step's standing connect ask.
    if (event.data.status === 'passed') snapshot.connectionNeeds.delete(event.data.node_id);
  } else if (event.event === 'connection_needed') {
    snapshot.connectionNeeds.set(event.data.node_id, { ...event.data });
  } else if (event.event === 'op_applied') {
    snapshot.ir = event.data.ir;
  } else if (event.event === 'offer') {
    snapshot.offerPending = true;
  }
}

/** Replay depth — text deltas dominate; older events fall off a very long session. */
export const EVENT_BUFFER_CAP = 1000;

/**
 * Assign the next seq, fold into the reattach snapshot, buffer for replay,
 * and forward to the live consumer (if any).
 */
export function emitToSession(session: ComposerSession, event: ComposerEvent): void {
  session.seq += 1;
  foldIntoSnapshot(session.snapshot, event);
  const sequenced = { ...event, seq: session.seq };
  session.buffer.push(sequenced);
  if (session.buffer.length > EVENT_BUFFER_CAP) session.buffer.shift();
  session.persist?.(sequenced);
  session.subscriber?.push(sequenced);
}

/**
 * Record the user's message in the durable transcript (buffer + write-through)
 * WITHOUT pushing it to the live consumer — the sender already renders its own
 * message optimistically; replaying it live would double it. Attach replay is
 * the only path that delivers user_message events to a client.
 */
export function recordUserMessage(session: ComposerSession, text: string): void {
  session.seq += 1;
  const sequenced: SequencedComposerEvent = { event: 'user_message', data: { text }, seq: session.seq };
  session.buffer.push(sequenced);
  if (session.buffer.length > EVENT_BUFFER_CAP) session.buffer.shift();
  session.persist?.(sequenced);
}

/**
 * Replay one persisted event into a freshly created session (attach
 * rehydration): the session ends up indistinguishable from one that lived
 * through the events — same seq, same snapshot, same ring buffer (capped),
 * same draft. No subscriber push and no re-persist: the event already IS
 * history.
 */
export function rehydrateIntoSession(session: ComposerSession, event: SequencedComposerEvent): void {
  if (event.seq > session.seq) session.seq = event.seq;
  foldIntoSnapshot(session.snapshot, event);
  if (event.event === 'op_applied') session.draftIr = event.data.ir;
  session.buffer.push(event);
  if (session.buffer.length > EVENT_BUFFER_CAP) session.buffer.shift();
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 200;

@Injectable()
export class SessionStore implements OnApplicationShutdown {
  private readonly logger = new Logger(SessionStore.name);
  private readonly sessions = new Map<string, ComposerSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  create(workflowId: string | null, draftIr: WorkflowIr | null): ComposerSession {
    if (this.sessions.size >= MAX_SESSIONS) this.evictOldestIdle();
    const session: ComposerSession = {
      id: randomUUID(),
      sdkSessionId: null,
      workflowId,
      threadId: null,
      userKey: null,
      persist: null,
      draftIr,
      busy: false,
      lastUsedAt: Date.now(),
      seq: 0,
      buffer: [],
      subscriber: null,
      callerToken: null,
      turnAbort: null,
      orphanTimer: null,
      snapshot: {
        brief: null,
        questions: new Map(),
        assumptions: [],
        stepResults: new Map(),
        connectionNeeds: new Map(),
        ir: null,
        offerPending: false,
      },
      fixAttempts: new Map(),
      lastFailedNodeId: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): ComposerSession | undefined {
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = Date.now();
    return session;
  }

  /** The live session already bound to a durable thread, if any (identity attach). */
  /** Drop a session outright (thread cleared) — aborts a turn in flight. */
  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.turnAbort?.abort();
    if (session.orphanTimer) clearTimeout(session.orphanTimer);
    this.sessions.delete(id);
  }

  findByThread(threadId: string): ComposerSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        session.lastUsedAt = Date.now();
        return session;
      }
    }
    return undefined;
  }

  onApplicationShutdown(): void {
    clearInterval(this.sweeper);
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) {
      if (!s.busy && s.lastUsedAt < cutoff) this.sessions.delete(id);
    }
  }

  private evictOldestIdle(): void {
    let oldest: ComposerSession | null = null;
    for (const s of this.sessions.values()) {
      if (!s.busy && (!oldest || s.lastUsedAt < oldest.lastUsedAt)) oldest = s;
    }
    if (oldest) {
      this.sessions.delete(oldest.id);
      this.logger.warn(`session cap reached — evicted idle session ${oldest.id}`);
    }
  }
}
