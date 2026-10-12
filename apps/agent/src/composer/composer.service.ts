import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { query, type SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';

import type { EnvConfig } from '../config/env.config';
import { buildComposerServer, COMPOSER_TOOL_NAMES, summarizeDraft } from './agent-tools';
import { EventChannel } from './event-channel';
import { anthropicParamCompleter, type ParamCompleteFn } from './param-filler';
import { PendingAnswers } from './pending-answers';
import { providerFailureMessage } from './provider-failure';
import type { AttachEvent, CanvasStep, ComposerEvent, SequencedComposerEvent, WorkflowIr } from './protocol';
import {
  emitToSession,
  recordUserMessage,
  rehydrateIntoSession,
  SessionStore,
  snapshotOf,
  stepsOf,
  type ComposerSession,
} from './sessions';
import { composerSystemPrompt } from './system-prompt';
import { ThreadStore, type ThreadRecord } from './thread-store';
import { WorkflowServiceClient } from './workflow-client';
import { PlatformKeysClient } from '../config/platform-keys.client';

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
  /** The branch that canvas belongs to, so the composer never claims a save changes what runs when it doesn't. */
  branch?: string;
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

@Injectable()
export class ComposerService {
  private readonly logger = new Logger(ComposerService.name);
  private readonly env: EnvConfig;

  constructor(
    @Inject(ConfigService) config: ConfigService<{ env: EnvConfig }, true>,
    private readonly sessions: SessionStore,
    private readonly threads: ThreadStore,
    private readonly workflowService: WorkflowServiceClient,
    private readonly answers: PendingAnswers,
    @Inject(QUERY_FN) private readonly queryFn: QueryFn,
    private readonly platformKeys: PlatformKeysClient,
  ) {
    this.env = config.get('env', { infer: true });
  }

  /** Non-null only when PARAM_MODEL is set — gates the fill_params tool AND its prompt section. */
  private paramCompleterFor(anthropicApiKey: string): ParamCompleteFn | null {
    return this.env.paramModel ? anthropicParamCompleter(anthropicApiKey, this.env.paramModel) : null;
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
    callerOrgId: string | null,
    userKey: string | null = null,
  ): AsyncGenerator<SequencedComposerEvent> {
    const workflowId = request.workflow_id ?? null;
    const session = request.session_id
      ? this.sessions.get(request.session_id)
      : ((await this.threadSession(userKey, workflowId)) ??
        this.sessions.create(workflowId, request.ir ?? null));
    if (!session) {
      yield { event: 'error', data: { message: 'Unknown or expired session — start a new one.' }, seq: 0 };
      return;
    }
    if (session.busy) {
      yield { event: 'error', data: { message: 'This session is already handling a message.' }, seq: 0 };
      return;
    }

    session.busy = true;
    session.turnBaseIr = request.ir ?? null;
    try {
      // Freshest caller credentials win — tool calls run AS the user.
      if (callerToken) session.callerToken = callerToken;
      session.callerOrgId = callerOrgId;
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
      const canvas = request.ir ?? null;
      const branch = request.branch ?? null;
      const missing = canvas ? notOnCanvas(session, canvas, branch) : [];
      if (canvas) session.draftIr = canvas;

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
      recordUserMessage(session, request.message, { branch, steps: canvas ? stepsOf(canvas) : null });
      const turn = this.runTurn(session, request.message, missing);
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
      session.turnBaseIr = null;
      session.lastUsedAt = Date.now();
    }
  }

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

  /** Reattach after a refresh or restart: replay the thread (durable log, else memory), a `replayed` marker, then any live turn — deduped by seq. */
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
    const turnBase = session.busy ? session.turnBaseIr : null;
    yield { event: 'replayed', data: turnBase ? { turn_base: turnBase } : {}, seq: delivered };
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

  /** Attach session resolution: in-memory session id first; else the caller's durable thread. */
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
    return keyed ? this.threadSession(userKey, request.workflowId ?? null) : null;
  }

  /**
   * The caller's durable thread (find-or-create), served by the live session
   * bound to it or a session rehydrated from the persisted event log; null
   * when persistence is off or the thread can't be resolved.
   */
  private async threadSession(
    userKey: string | null,
    workflowId: string | null,
  ): Promise<ComposerSession | null> {
    if (!this.threads.enabled || !userKey) return null;
    try {
      const thread = await this.threads.resolve(userKey, workflowId);
      return this.sessions.findByThread(thread.id) ?? (await this.rehydrate(thread, userKey, workflowId));
    } catch (err) {
      this.logger.warn(`thread lookup failed (${workflowId ?? 'scratch'}): ${messageOf(err)}`);
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
      if (!(await this.threads.rekey(session.threadId, workflowId))) {
        // The workflow went first and took the thread with it: the session goes on memory-only.
        session.threadId = null;
        session.persist = null;
      }
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
  private async runTurn(session: ComposerSession, message: string, missing: CanvasStep[]): Promise<void> {
    const startedAt = Date.now();
    // Per-turn state: the two-fix bound counts within one turn; a new message
    // also supersedes any standing save offer.
    session.fixAttempts = new Map();
    session.lastFailedNodeId = null;
    session.snapshot.offerPending = false;
    session.turnAbort = new AbortController();
    const abort = AbortSignal.any([session.turnAbort.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
    const emit = (event: ComposerEvent): void => emitToSession(session, event);
    // ComposerEnabledGuard already 503s every route into here without a key; reaching this
    // without one means it was cleared mid-turn, and a keyless subprocess would surface that
    // as an opaque SDK failure instead.
    const anthropicApiKey = await this.platformKeys.anthropicApiKey({
      token: session.callerToken,
      orgId: session.callerOrgId,
    });
    if (!anthropicApiKey) throw new Error('No Anthropic API key is configured — the composer is disabled.');
    const paramCompleter = this.paramCompleterFor(anthropicApiKey);
    const server = buildComposerServer({
      session,
      client: this.workflowService,
      emit,
      answers: this.answers,
      paramCompleter,
    });

    const q = this.queryFn({
      prompt: this.buildPrompt(session, message, missing),
      options: {
        model: this.env.composerModel,
        systemPrompt: composerSystemPrompt(paramCompleter !== null),
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
          // The SDK's own usage and error reporting, which the docs promise a self-host never sends.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      },
    });
    const onAbort = (): void => q.close();
    abort.addEventListener('abort', onAbort, { once: true });

    let sawResult = false;
    let sawText = false;
    let providerError: SDKAssistantMessageError | null = null;
    const failure = (): string => providerFailureMessage(providerError, this.env.composerModel);
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
        } else if (msg.type === 'assistant' && msg.error) {
          providerError = msg.error;
        } else if (msg.type === 'result') {
          sawResult = true;
          if (msg.subtype !== 'success') {
            this.logger.error(`turn ended with ${msg.subtype} (session ${session.id})`);
            emit({
              event: 'error',
              data: { message: `The composer stopped early (${msg.subtype}).` },
            });
          } else if (msg.is_error) {
            this.logger.error(
              `the provider refused the turn: ${providerError ?? 'no reason given'} (session ${session.id})`,
            );
            emit({ event: 'error', data: { message: failure() } });
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
            message: abort.aborted ? 'The conversation was interrupted — the build stopped.' : failure(),
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
      // The SDK throws after an error result it has already delivered; that turn is closed.
      if (!sawResult) {
        emit({ event: 'error', data: { message: failure() } });
        emit({
          event: 'done',
          data: { session_id: session.id, duration_ms: Date.now() - startedAt },
        });
      }
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
  private buildPrompt(session: ComposerSession, message: string, missing: CanvasStep[]): string {
    const parts: string[] = [];
    if (session.canvasBranch && session.canvasBranch !== 'main') {
      parts.push(
        `<canvas_branch>${session.canvasBranch} — not main: its versions reach what runs only through a merge into main and a publish, or a promotion.</canvas_branch>`,
      );
    }
    if (session.draftIr && Array.isArray(session.draftIr.nodes) && session.draftIr.nodes.length > 0) {
      const json = JSON.stringify(session.draftIr);
      parts.push(
        `<canvas_state>\n${json.length <= 30_000 ? json : summarizeDraft(session.draftIr)}\n</canvas_state>`,
      );
    } else {
      parts.push('<canvas_state>empty — no steps yet</canvas_state>');
    }
    if (missing.length > 0) {
      const named = missing.map((step) => `"${step.name}" (${step.id})`).join(', ');
      parts.push(`<canvas_changes>Not on the canvas now: ${named}.</canvas_changes>`);
    }
    parts.push(message);
    return parts.join('\n\n');
  }
}

// Steps of the composer's last draft that the canvas lacks — a fact about the canvas, never a claim of who removed them.
function notOnCanvas(session: ComposerSession, canvas: WorkflowIr, branch: string | null): CanvasStep[] {
  if (!session.draftSteps || branch === null || branch !== session.canvasBranch) return [];
  const shown = new Set(stepsOf(canvas).map((step) => step.id));
  return session.draftSteps.filter((step) => !shown.has(step.id));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
