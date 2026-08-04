import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { query } from '@anthropic-ai/claude-agent-sdk';

import type { EnvConfig } from '../config/env.config';
import { buildComposerServer, COMPOSER_TOOL_NAMES, summarizeDraft } from './agent-tools';
import { EventChannel } from './event-channel';
import { anthropicParamCompleter, type ParamCompleteFn } from './param-filler';
import { PendingAnswers } from './pending-answers';
import type { AttachEvent, ComposerEvent, SequencedComposerEvent, WorkflowIr } from './protocol';
import {
  emitToSession,
  recordUserMessage,
  rehydrateIntoSession,
  SessionStore,
  snapshotOf,
  type ComposerSession,
} from './sessions';
import { composerSystemPrompt } from './system-prompt';
import { ThreadStore, type ThreadRecord } from './thread-store';
import { WorkflowServiceClient } from './workflow-client';

/**
 * One composer turn: user message in, protocol events out. The SDK loop and
 * the tool handlers both write into an EventChannel; the controller drains it
 * to the SSE response. Draft state lives on the in-memory session.
 */

export interface StreamRequest {
  message: string;
  session_id?: string;
  workflow_id?: string;
  /** The editor's CURRENT canvas document — refreshed every message so user edits between turns are honored. */
  ir?: WorkflowIr | null;
}

/**
 * Attach resolution keys, in precedence order: a live in-memory session id
 * (same-tab fast path), else the caller's durable thread — (user, workflow),
 * or the user's ONE scratch thread when `scratch` is set (pre-save compose).
 */
export interface AttachRequest {
  sessionId?: string;
  workflowId?: string | null;
  scratch?: boolean;
  /** Replay everything after this seq (0 = the full thread, from seq 1). */
  lastSeq: number;
}

/** Injectable so tests drive the mapping with a scripted message stream. */
export const QUERY_FN = Symbol('QUERY_FN');
export type QueryFn = typeof query;

// Must comfortably exceed the ask_user pause ceiling (5 min) — a turn that
// waits on one question plus builds afterwards is the normal case, not the edge.
const TURN_TIMEOUT_MS = 12 * 60 * 1000;
/**
 * How long a live turn survives with NO connected consumer before it's
 * aborted (A2): a page refresh reattaches within seconds; a genuinely
 * abandoned tab stops spending tokens inside this window.
 */
const ORPHAN_GRACE_MS = 90 * 1000;
const MAX_TURNS = 40;
const GENERIC_ERROR = 'The composer hit a problem — please try again.';

@Injectable()
export class ComposerService {
  private readonly logger = new Logger(ComposerService.name);
  private readonly env: EnvConfig;
  /** Non-null only when PARAM_MODEL is set — gates the fill_params tool AND its prompt section. */
  private readonly paramCompleter: ParamCompleteFn | null;

  constructor(
    @Inject(ConfigService) config: ConfigService<{ env: EnvConfig }, true>,
    private readonly sessions: SessionStore,
    private readonly threads: ThreadStore,
    private readonly workflowService: WorkflowServiceClient,
    private readonly answers: PendingAnswers,
    @Inject(QUERY_FN) private readonly queryFn: QueryFn,
  ) {
    this.env = config.get('env', { infer: true });
    this.paramCompleter =
      this.env.paramModel && this.env.anthropicApiKey
        ? anthropicParamCompleter(this.env.anthropicApiKey, this.env.paramModel)
        : null;
  }

  /**
   * Resolve the session, run one agent turn, and stream sequenced protocol
   * events. Always terminates with `done` or `error`. The channel registers
   * as the session's ONE live subscriber — an attach (page refresh) replaces
   * it and this response ends quietly at turn end.
   */
  async *stream(
    request: StreamRequest,
    clientGone: AbortSignal,
    callerToken: string | null,
    userKey: string | null = null,
  ): AsyncGenerator<SequencedComposerEvent> {
    const session = request.session_id
      ? this.sessions.get(request.session_id)
      : this.sessions.create(request.workflow_id ?? null, request.ir ?? null);
    if (!session) {
      yield { event: 'error', data: { message: 'Unknown or expired session — start a new one.' }, seq: 0 };
      return;
    }
    if (session.busy) {
      yield { event: 'error', data: { message: 'This session is already handling a message.' }, seq: 0 };
      return;
    }

    session.busy = true;
    try {
      // Freshest caller credentials win — tool calls run AS the user.
      if (callerToken) session.callerToken = callerToken;
      // A session that started before its workflow existed (composer-first new
      // build) binds to it on the first message carrying the id — never
      // rebinds. Its durable thread moves with it (scratch → the created
      // workflow; an existing thread for that key yields to this history).
      if (!session.workflowId && request.workflow_id) {
        session.workflowId = request.workflow_id;
        await this.rekeyThread(session, request.workflow_id);
      }
      // Durable thread binding (find-or-create by (user, workflow)) — fail-soft.
      await this.bindThread(session, userKey);
      // The editor's canvas is the source of truth for the draft: refresh it
      // on every message so manual edits between turns are never clobbered.
      if (request.ir !== undefined && request.ir !== null) session.draftIr = request.ir;
      if (!session.draftIr && session.workflowId) await this.seedFromWorkflow(session);

      // Bookkeeping, not history: the session id is not buffered for replay.
      yield { event: 'session', data: { session_id: session.id }, seq: session.seq };

      const channel = new EventChannel<SequencedComposerEvent>();
      session.subscriber?.close();
      session.subscriber = channel;
      if (session.orphanTimer) {
        clearTimeout(session.orphanTimer);
        session.orphanTimer = null;
      }
      // A dropped connection does NOT kill the turn — it survives the orphan
      // grace period so a refresh can reattach (POST /api/composer/attach).
      const onGone = (): void => this.dropSubscriber(session, channel);
      clientGone.addEventListener('abort', onGone, { once: true });
      // The transcript's turn opener — persisted/buffered for attach replay,
      // never sent live (the sender renders its own message optimistically).
      recordUserMessage(session, request.message);
      const turn = this.runTurn(session, request.message);
      try {
        for await (const event of channel) {
          if (clientGone.aborted) break;
          yield event;
        }
        await turn;
      } finally {
        clientGone.removeEventListener('abort', onGone);
      }
    } finally {
      session.busy = false;
      session.lastUsedAt = Date.now();
    }
  }

  /**
   * Reattach after a refresh/drop/restart. Session resolution: the given
   * session id when it's still live in memory (same-tab fast path), else the
   * caller's durable thread — (user, workflow) or the scratch thread — which
   * finds a live session bound to it or REHYDRATES one from the Postgres
   * event log (survives agent-service restarts and the session TTL).
   *
   * Replay, in order of preference:
   *  - DURABLE LOG: the thread's full transcript after `lastSeq` (from seq 1
   *    on a fresh page), the exact live event shapes — the chat panel renders
   *    through the same reducer path as live and comes back IDENTICAL. Any
   *    buffered tail the async write-through hasn't landed yet follows.
   *  - Memory-only fallback (no DATABASE_URL / DB down): the pre-thread
   *    behavior — gap-free buffered tail when lastSeq allows, else ONE
   *    `snapshot` event (the canvas-state supplement) carrying current state.
   * Then — when a turn is live — continue streaming it; idle sessions end
   * after the replay. Replay + live are deduped by seq.
   */
  /**
   * Clear the caller's (user, workflow) conversation (owner, 2026-07-14):
   * delete the durable thread and drop any live session on it. Memory-only
   * mode has nothing durable — the client resets and the session TTLs out.
   */
  async clearThread(userKey: string, workflowId: string | null): Promise<{ cleared: boolean }> {
    const removed = await this.threads.deleteThread(userKey, workflowId);
    if (removed) {
      const live = this.sessions.findByThread(removed.threadId);
      if (live) this.sessions.remove(live.id);
      return { cleared: true };
    }
    return { cleared: false };
  }

  async *attach(
    request: AttachRequest,
    clientGone: AbortSignal,
    userKey: string | null = null,
  ): AsyncGenerator<AttachEvent> {
    const session = await this.locateForAttach(request, userKey);
    if (!session) {
      yield { event: 'error', data: { message: 'Unknown or expired session — start a new one.' }, seq: 0 };
      return;
    }
    yield { event: 'session', data: { session_id: session.id }, seq: session.seq };

    const channel = new EventChannel<SequencedComposerEvent>();
    session.subscriber?.close();
    session.subscriber = channel;
    if (session.orphanTimer) {
      clearTimeout(session.orphanTimer);
      session.orphanTimer = null;
    }
    const onGone = (): void => this.dropSubscriber(session, channel);
    clientGone.addEventListener('abort', onGone, { once: true });

    let delivered = request.lastSeq;
    const durable = session.threadId ? await this.loadDurableLog(session.threadId, delivered) : null;
    if (durable) {
      for (const event of durable) {
        if (clientGone.aborted) break;
        if (event.seq <= delivered) continue;
        delivered = event.seq;
        yield event;
      }
      // The write-through is async — the freshest events may only exist in
      // the ring buffer yet.
      for (const event of [...session.buffer]) {
        if (clientGone.aborted) break;
        if (event.seq <= delivered) continue;
        delivered = event.seq;
        yield event;
      }
    } else {
      const oldestBuffered = session.buffer[0]?.seq ?? session.seq + 1;
      const gapFree = request.lastSeq > 0 && request.lastSeq >= oldestBuffered - 1;
      if (gapFree) {
        for (const event of [...session.buffer]) {
          if (clientGone.aborted) break;
          if (event.seq <= delivered) continue;
          delivered = event.seq;
          yield event;
        }
      } else {
        // State beats history: everything the surfaces need, in one event.
        delivered = session.seq;
        yield { event: 'snapshot', data: snapshotOf(session), seq: session.seq };
      }
    }
    if (!session.busy || clientGone.aborted) {
      clientGone.removeEventListener('abort', onGone);
      if (session.subscriber === channel) session.subscriber = null;
      channel.close();
      return;
    }
    try {
      for await (const event of channel) {
        if (clientGone.aborted) break;
        if (event.seq <= delivered) continue;
        delivered = event.seq;
        yield event;
      }
    } finally {
      clientGone.removeEventListener('abort', onGone);
      if (session.subscriber === channel) session.subscriber = null;
    }
  }

  /**
   * Attach session resolution: in-memory session id first; else the caller's
   * durable thread (find-or-create), served by the live session bound to it
   * or a session rehydrated from the persisted event log.
   */
  private async locateForAttach(
    request: AttachRequest,
    userKey: string | null,
  ): Promise<ComposerSession | null> {
    const byId = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    if (byId) {
      await this.bindThread(byId, userKey); // no-op when already bound (or persistence is off)
      return byId;
    }
    const keyed = request.scratch === true || typeof request.workflowId === 'string';
    if (!this.threads.enabled || !userKey || !keyed) return null;
    const workflowId = request.workflowId ?? null;
    try {
      const thread = await this.threads.resolve(userKey, workflowId);
      const live = this.sessions.findByThread(thread.id);
      if (live) return live;
      return await this.rehydrate(thread, userKey, workflowId);
    } catch (err) {
      this.logger.warn(
        `thread attach failed (${workflowId ?? 'scratch'}) — nothing to replay: ${messageOf(err)}`,
      );
      return null;
    }
  }

  /**
   * Rebuild an in-memory session from the thread's persisted event log — the
   * result is indistinguishable from a session that lived through the events
   * (seq, snapshot, capped ring buffer, draft). The stored SDK session id is
   * adopted only while its transcript file survives; otherwise the next turn
   * starts a fresh SDK session (the prompt re-seeds context — canvas state
   * travels with every message).
   */
  private async rehydrate(
    thread: ThreadRecord,
    userKey: string,
    workflowId: string | null,
  ): Promise<ComposerSession> {
    const session = this.sessions.create(workflowId, null);
    this.adoptThread(session, userKey, thread);
    for (const event of await this.threads.loadEvents(thread.id, 0)) {
      rehydrateIntoSession(session, event);
    }
    return session;
  }

  /** Find-or-create the caller's thread and bind it to the session — fail-soft (memory-only on error). */
  private async bindThread(session: ComposerSession, userKey: string | null): Promise<void> {
    if (!this.threads.enabled || !userKey || session.threadId) return;
    try {
      this.adoptThread(session, userKey, await this.threads.resolve(userKey, session.workflowId));
    } catch (err) {
      this.logger.warn(
        `thread resolve failed — session ${session.id} continues memory-only: ${messageOf(err)}`,
      );
    }
  }

  /** Wire a resolved thread onto the session: write-through, seq continuity, SDK resume. */
  private adoptThread(session: ComposerSession, userKey: string, thread: ThreadRecord): void {
    session.userKey = userKey;
    session.threadId = thread.id;
    session.persist = (event) => this.threads.append(thread.id, event);
    // New events continue the durable sequence, never collide with it.
    if (thread.lastSeq > session.seq) session.seq = thread.lastSeq;
    if (!session.sdkSessionId && thread.sdkSessionId && this.threads.transcriptExists(thread.sdkSessionId)) {
      session.sdkSessionId = thread.sdkSessionId;
    }
  }

  /** Move the session's thread to the newly created workflow key (accept path) — fail-soft. */
  private async rekeyThread(session: ComposerSession, workflowId: string): Promise<void> {
    if (!this.threads.enabled || !session.threadId) return;
    try {
      await this.threads.rekey(session.threadId, workflowId);
    } catch (err) {
      this.logger.warn(`thread rekey failed (session ${session.id}): ${messageOf(err)}`);
    }
  }

  /** The persisted transcript after `afterSeq` — null falls attach back to the memory paths. */
  private async loadDurableLog(threadId: string, afterSeq: number): Promise<SequencedComposerEvent[] | null> {
    if (!this.threads.enabled) return null;
    try {
      return await this.threads.loadEvents(threadId, afterSeq);
    } catch (err) {
      this.logger.warn(`durable replay unavailable (thread ${threadId}): ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * The live consumer vanished (refresh, closed tab). Free the channel and —
   * when a turn is running — arm the orphan abort: reattach within the grace
   * period keeps the turn; silence kills it (bounded token spend).
   */
  private dropSubscriber(session: ComposerSession, channel: EventChannel<SequencedComposerEvent>): void {
    if (session.subscriber !== channel) return; // already replaced by a reattach
    session.subscriber = null;
    channel.close();
    if (!session.busy) return;
    session.orphanTimer = setTimeout(() => {
      session.orphanTimer = null;
      if (session.busy && session.subscriber === null) {
        this.logger.warn(`session ${session.id}: no consumer reattached — aborting the orphaned turn`);
        session.turnAbort?.abort();
      }
    }, ORPHAN_GRACE_MS);
    session.orphanTimer.unref();
  }

  /**
   * Consume the SDK stream, mapping messages → protocol events through the
   * session emitter (buffered for replay + forwarded to the live consumer).
   * Closes whatever consumer is live when the turn ends.
   */
  private async runTurn(session: ComposerSession, message: string): Promise<void> {
    const startedAt = Date.now();
    // Per-turn state: the two-fix bound counts within one turn; a new message
    // also supersedes any standing save offer.
    session.fixAttempts = new Map();
    session.lastFailedNodeId = null;
    session.snapshot.offerPending = false;
    session.turnAbort = new AbortController();
    const abort = AbortSignal.any([session.turnAbort.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
    const emit = (event: ComposerEvent): void => emitToSession(session, event);
    // ComposerEnabledGuard already 503s every route into here without a key;
    // reaching this without one is a wiring bug, and spawning a keyless
    // subprocess would surface it as an opaque SDK failure instead.
    const anthropicApiKey = this.env.anthropicApiKey;
    if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured — the composer is disabled.');
    const server = buildComposerServer({
      session,
      client: this.workflowService,
      emit,
      answers: this.answers,
      paramCompleter: this.paramCompleter,
    });

    const q = this.queryFn({
      prompt: this.buildPrompt(session, message),
      options: {
        model: this.env.composerModel,
        systemPrompt: composerSystemPrompt(this.paramCompleter !== null),
        mcpServers: { composer: server },
        // Custom-tools-only: no built-in file/bash tools in context at all.
        tools: [],
        allowedTools: [...COMPOSER_TOOL_NAMES],
        includePartialMessages: true,
        maxTurns: MAX_TURNS,
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        // Minimal explicit allowlist (A1 hardening): the subprocess gets what
        // it needs to run and authenticate — never the whole parent env
        // (which holds the ork_ service key, DB URLs, etc.).
        // MCP_TOOL_TIMEOUT covers the ask_user pause: the in-process tool call
        // legitimately blocks for up to QUESTION_TIMEOUT_MS.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ANTHROPIC_API_KEY: anthropicApiKey,
          MCP_TIMEOUT: '30000',
          MCP_TOOL_TIMEOUT: '360000',
        },
      },
    });
    const onAbort = (): void => q.close();
    abort.addEventListener('abort', onAbort, { once: true });

    let sawResult = false;
    let sawText = false;
    try {
      for await (const msg of q) {
        if (abort.aborted) break;
        if (msg.type === 'system' && msg.subtype === 'init') {
          session.sdkSessionId = msg.session_id;
          // Durable resume key: a rehydrated thread can pick the SDK session
          // back up while its transcript file survives.
          if (session.threadId) this.threads.recordSdkSession(session.threadId, msg.session_id);
        } else if (msg.type === 'stream_event') {
          const event = msg.event;
          if (event.type === 'content_block_start' && event.content_block.type === 'text' && sawText) {
            // New narration block after a tool call — without a break the SSE
            // text concatenates across blocks ("…the steps.Got the pieces").
            emit({ event: 'assistant_text', data: { text: '\n\n' } });
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            sawText = true;
            emit({ event: 'assistant_text', data: { text: event.delta.text } });
          }
        } else if (msg.type === 'result') {
          sawResult = true;
          const isError = msg.subtype !== 'success';
          if (isError) {
            this.logger.error(`turn ended with ${msg.subtype} (session ${session.id})`);
            emit({
              event: 'error',
              data: { message: `The composer stopped early (${msg.subtype}).` },
            });
          }
          emit({
            event: 'done',
            data: {
              session_id: session.id,
              duration_ms: Date.now() - startedAt,
              num_turns: msg.num_turns,
              total_cost_usd: msg.total_cost_usd,
            },
          });
        }
      }
      if (!sawResult) {
        // Subprocess ended without a result (orphan-aborted, timed out, or
        // died) — the buffered history must still END coherently for replay.
        emit({
          event: 'error',
          data: {
            message: abort.aborted ? 'The conversation was interrupted — the build stopped.' : GENERIC_ERROR,
          },
        });
        emit({
          event: 'done',
          data: { session_id: session.id, duration_ms: Date.now() - startedAt },
        });
      }
    } catch (err) {
      this.logger.error(
        `agent turn failed (session ${session.id})`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      emit({ event: 'error', data: { message: GENERIC_ERROR } });
      emit({
        event: 'done',
        data: { session_id: session.id, duration_ms: Date.now() - startedAt },
      });
    } finally {
      abort.removeEventListener('abort', onAbort);
      session.turnAbort = null;
      if (session.orphanTimer) {
        clearTimeout(session.orphanTimer);
        session.orphanTimer = null;
      }
      // A turn that dies while paused on ask_user must not leave the question
      // answerable — late answers get a clean "unknown question".
      this.answers.cancelForSession(session.id);
      // End whichever SSE consumer is live (the original stream OR an attach).
      session.subscriber?.close();
      session.subscriber = null;
    }
  }

  /** Long-turn token refresh (A3): the client calls this when Clerk rotates the token mid-stream. */
  refreshToken(sessionId: string, callerToken: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (callerToken) session.callerToken = callerToken;
    return true;
  }

  /** Answer a pending clarifying question (thread chip or canvas chip — first answer wins). */
  answerQuestion(sessionId: string, questionId: string, answer: string, callerToken: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // An answer often arrives after a long pause — its fresh token unblocks
    // the tool calls that follow (Clerk session JWTs are short-lived).
    if (callerToken) session.callerToken = callerToken;
    return this.answers.answer(sessionId, questionId, answer);
  }

  /** The user message plus the current canvas so the agent never edits blind. */
  private buildPrompt(session: ComposerSession, message: string): string {
    const parts: string[] = [];
    if (session.draftIr && Array.isArray(session.draftIr.nodes) && session.draftIr.nodes.length > 0) {
      const json = JSON.stringify(session.draftIr);
      parts.push(
        `<canvas_state>\n${json.length <= 30_000 ? json : summarizeDraft(session.draftIr)}\n</canvas_state>`,
      );
    } else {
      parts.push('<canvas_state>empty — no steps yet</canvas_state>');
    }
    parts.push(message);
    return parts.join('\n\n');
  }

  /** Best effort: opening a session on a committed workflow seeds the draft from its head. */
  private async seedFromWorkflow(session: ComposerSession): Promise<void> {
    if (!session.workflowId) return;
    try {
      const wf = await this.workflowService.readWorkflow(session.workflowId, session.callerToken);
      session.draftIr = wf.ir;
    } catch (err) {
      this.logger.warn(`could not seed draft from workflow ${session.workflowId}: ${messageOf(err)}`);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
