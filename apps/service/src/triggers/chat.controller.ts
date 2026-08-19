import {
  Body,
  Controller,
  Header,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Observable } from 'rxjs';

import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { AgentStepBus, channelKey } from '../runtime/agent-step-bus';
import { TriggersService } from './triggers.service';

/** Idle keepalive cadence — a named `ping` frame every 15s so proxies never drop the stream. */
const HEARTBEAT_MS = 15_000;

/**
 * The public SYNCHRONOUS chat intake — NO auth guard: the unguessable
 * per-`(workflow, env)` path is the capability token. Locked contract:
 * `POST /api/chat/:workflowId/:env` `{ chatInput, sessionId?, action? }` →
 * 200 `{ run_id, session_id, reply, outputs }`, 404 when the env has no live chat node.
 */
@Controller('api/chat')
export class ChatController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly agentStepBus: AgentStepBus,
  ) {}

  /**
   * The LIVE agent-step SSE side-channel:
   * `GET /api/chat/:workflowId/:env/events?session_id=X`. Auth is `none` — the scoped
   * `workflow:env:session` channel key is the capability. The SSE `id` is the bus's per-channel
   * monotonic `seq`, NOT `step_index` (which resets to 0 on every agent-loop invocation, so a
   * client deduping on it would drop a later invocation's steps).
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  @Sse(':workflowId/:env/events')
  streamChatEvents(
    @Param('workflowId') workflowId: string,
    @Param('env') env: string,
    @Query('session_id') sessionId: string,
  ): Observable<MessageEvent> {
    if (!isIdShape(workflowId)) throw new DomainError('Chat workflow not found', 404);
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new DomainError('A "session_id" query parameter is required', 400);
    }
    const steps$ = this.agentStepBus.subscribe(channelKey(workflowId, env, sessionId));
    // One Observable, so the keepalive ticker stops the instant the stream ends or the
    // client disconnects.
    return new Observable<MessageEvent>((subscriber) => {
      const inner = steps$.subscribe({
        next: ({ seq, step }) => subscriber.next({ data: step, id: String(seq) }),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      const heartbeat = setInterval(
        () => subscriber.next({ type: 'ping', data: `${Date.now()}` }),
        HEARTBEAT_MS,
      );
      heartbeat.unref?.();
      return () => {
        clearInterval(heartbeat);
        inner.unsubscribe();
      };
    });
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':workflowId/:env')
  async fireChat(
    @Param('workflowId') workflowId: string,
    @Param('env') env: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!isIdShape(workflowId)) throw new DomainError('Chat workflow not found', 404);
    const { chatInput, sessionId, action } = parseChatBody(body);
    const reply = await this.triggers.fireWorkflowChat(workflowId, env, { chatInput, sessionId, action });
    return {
      run_id: reply.runId,
      session_id: reply.sessionId,
      reply: reply.reply,
      outputs: reply.outputs,
    };
  }
}

/** Validate + narrow the chat request body to the locked shape (`chatInput` required, non-empty). */
function parseChatBody(body: unknown): { chatInput: string; sessionId?: string; action?: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('Chat request body must be an object with a "chatInput" string', 400);
  }
  const record = body as Record<string, unknown>;
  if (typeof record.chatInput !== 'string' || record.chatInput.length === 0) {
    throw new DomainError('Chat request needs a non-empty "chatInput" string', 400);
  }
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
  const action = typeof record.action === 'string' ? record.action : undefined;
  return { chatInput: record.chatInput, sessionId, action };
}
