import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/**
 * The pause mechanics for ask_user (A1): the tool handler awaits a promise
 * registered here; POST /api/composer/answer resolves it. Chosen over the
 * SDK's canUseTool defer because canUseTool is a permission gate (allow/deny
 * a call), not an answer channel — a handler-await keeps the whole
 * question/answer exchange in one place, works with the in-process MCP
 * server, and needs no extra SDK machinery. First answer wins; a turn ending
 * for any reason cancels its session's outstanding questions so late answers
 * get a clean 404 instead of resolving into a dead turn.
 */

export type AnswerOutcome =
  { kind: 'answered'; answer: string } | { kind: 'timeout' } | { kind: 'cancelled' };

interface PendingQuestion {
  sessionId: string;
  resolve: (outcome: AnswerOutcome) => void;
}

@Injectable()
export class PendingAnswers {
  private readonly pending = new Map<string, PendingQuestion>();

  /** True when the session already has an unanswered question in flight. */
  hasPending(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Register a question; the promise settles exactly once (answer, timeout,
   * or cancel). ONE question per session at a time — a second concurrent
   * create throws (the prompt rule stays as the polite layer; this is the
   * hard one).
   */
  create(sessionId: string, timeoutMs: number): { questionId: string; outcome: Promise<AnswerOutcome> } {
    if (this.hasPending(sessionId)) {
      throw new Error('a question is already waiting for an answer — one at a time');
    }
    const questionId = randomUUID();
    const outcome = new Promise<AnswerOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(questionId, { kind: 'timeout' }), timeoutMs);
      timer.unref();
      this.pending.set(questionId, {
        sessionId,
        resolve: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
      });
    });
    return { questionId, outcome };
  }

  /** First answer wins. Returns false when the question is unknown, expired, or belongs to another session. */
  answer(sessionId: string, questionId: string, answer: string): boolean {
    const entry = this.pending.get(questionId);
    if (!entry || entry.sessionId !== sessionId) return false;
    return this.settle(questionId, { kind: 'answered', answer });
  }

  /** Turn ended (done/error/abort) — outstanding questions for the session die with it. */
  cancelForSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId === sessionId) this.settle(id, { kind: 'cancelled' });
    }
  }

  private settle(questionId: string, outcome: AnswerOutcome): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    entry.resolve(outcome);
    return true;
  }
}
