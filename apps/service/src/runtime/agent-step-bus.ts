import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

import { errorMessage } from '../common/error-message';
import { canonicalEnvName } from '../environments/env-name';
import type { AgentStep, AgentStepSink } from './agent';

/** Safety-net lifetime force-closing a channel that was subscribed but never closed, so none leaks. */
const CHANNEL_TTL_MS = 10 * 60 * 1000;

/**
 * The bus channel key — scoped by `workflow:env:session`, never the bare session id,
 * so a leaked id can't address another tenant's channel. BOTH ends of the bus must build the key
 * here so they agree byte-for-byte; `env` canonicalizes (invariant #7) so `prod` and `production`
 * still rendezvous.
 */
export function channelKey(workflowId: string, env: string, sessionId: string): string {
  return `${workflowId}:${canonicalEnvName(env)}:${sessionId}`;
}

/**
 * One live step frame as the SSE endpoint receives it. `seq` is the per-channel monotonic SSE `id` /
 * Last-Event-ID key — it never repeats or regresses, unlike `step.step_index`, which resets per
 * agent-loop invocation and would make a client deduping by it drop later steps.
 */
export interface SequencedStep {
  seq: number;
  step: AgentStep;
}

/** One session's live step channel — the multicast subject + a subscriber refcount + a monotonic seq + its TTL timer. */
interface Channel {
  subject: Subject<SequencedStep>;
  refCount: number;
  /** Monotonic, channel-unique sequence — the last `seq` handed out (0 = none yet). */
  seq: number;
  ttl: ReturnType<typeof setTimeout>;
}

/**
 * The channel-keyed in-process pub/sub carrying an agent run's live steps to the SSE side-channel
 * : the durable loop publishes, the `@Sse()` chat-events endpoint subscribes. Run
 * history is the source of truth, so the bus is deliberately best-effort — publishing with no live
 * channel is a silent drop, `publish` never blocks (backpressure is the socket's problem, no queue
 * is held), and a channel is dropped on last unsubscribe, `close`, or TTL.
 *
 * IN-MEMORY: publisher and subscriber must be the SAME process. Horizontal scale needs a shared
 * fan-out (Redis / LISTEN-NOTIFY) behind this same sink/subscribe surface — deliberately deferred.
 */
@Injectable()
export class AgentStepBus implements AgentStepSink {
  private readonly logger = new Logger(AgentStepBus.name);
  private readonly channels = new Map<string, Channel>();

  /**
   * Publish one recorded step to a channel's live subscribers, stamped with the channel's next
   * monotonic `seq`. A silent no-op when no channel is open for the key. Never throws.
   */
  publish(channelKey: string, step: AgentStep): void {
    const channel = this.channels.get(channelKey);
    if (!channel) return;
    try {
      channel.seq += 1;
      channel.subject.next({ seq: channel.seq, step });
    } catch (err) {
      // A subscriber's delivery threw (a dead SSE socket) — isolate it from the loop.
      this.logger.warn(`agent step publish failed for channel: ${errorMessage(err)}`);
    }
  }

  /**
   * Subscribe to a channel's live step stream. Subscribing creates or joins the channel and bumps
   * its refcount; the channel is torn down at zero. Subscribe BEFORE the run publishes.
   */
  subscribe(channelKey: string): Observable<SequencedStep> {
    return new Observable<SequencedStep>((subscriber) => {
      const channel = this.ensureChannel(channelKey);
      channel.refCount += 1;
      const inner = channel.subject.subscribe(subscriber);
      return () => {
        inner.unsubscribe();
        channel.refCount -= 1;
        if (channel.refCount <= 0) this.drop(channelKey);
      };
    });
  }

  /** Close a channel so every subscriber's SSE stream ends cleanly; idempotent. */
  close(channelKey: string): void {
    const channel = this.channels.get(channelKey);
    if (!channel) return;
    this.channels.delete(channelKey);
    clearTimeout(channel.ttl);
    channel.subject.complete();
  }

  /** Open channels, for test assertions on cleanup (no leak after a run ends). */
  get openSessionCount(): number {
    return this.channels.size;
  }

  private ensureChannel(channelKey: string): Channel {
    const existing = this.channels.get(channelKey);
    if (existing) return existing;
    const channel: Channel = {
      subject: new Subject<SequencedStep>(),
      refCount: 0,
      seq: 0,
      ttl: setTimeout(() => this.close(channelKey), CHANNEL_TTL_MS),
    };
    // A safety timer must never keep the process alive on its own.
    channel.ttl.unref?.();
    this.channels.set(channelKey, channel);
    return channel;
  }

  private drop(channelKey: string): void {
    const channel = this.channels.get(channelKey);
    if (!channel) return;
    this.channels.delete(channelKey);
    clearTimeout(channel.ttl);
    // Complete so any straggler subscription (should be none — refcount hit zero) ends.
    channel.subject.complete();
  }
}
