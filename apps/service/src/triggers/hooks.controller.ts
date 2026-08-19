import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { CatchStore } from './catch-store';
import { TriggersService } from './triggers.service';

/**
 * Public webhook intake — NO auth guard: the unguessable path is the capability token.
 * The run is fire-and-forget (202 + run_id); poll run history for the outcome.
 */
@Controller('api/hooks')
export class HooksController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly catches: CatchStore,
  ) {}

  /** Test-event intake: the payload becomes an editor sample — nothing runs. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('catch/:catchId')
  catchEvent(@Param('catchId') catchId: string, @Body() body: unknown): Record<string, unknown> {
    if (!isIdShape(catchId)) throw new DomainError('Catch not found or expired', 404);
    this.catches.receive(catchId, body ?? null);
    return { status: 'caught' };
  }

  /**
   * The GENERIC Composio trigger intake — one endpoint for every projected trigger
   * type. No auth guard: the Svix signature IS the capability (unverified → 401).
   */
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @HttpCode(202)
  @Post('composio')
  async fireComposio(@Body() body: unknown, @Req() req: Request): Promise<Record<string, unknown>> {
    // The Svix HMAC signs the EXACT received bytes: with no raw body, '' fails CLOSED (401)
    // rather than HMAC a re-serialized body that could never match.
    const rawBody = (req as { rawBody?: string }).rawBody ?? '';
    const headers = lowerCaseHeaders(req.headers);
    const { fired, duplicate } = await this.triggers.fireComposioDelivery({ body, rawBody, headers });
    // A duplicate is a SUCCESSFUL ack — an error here would only beget more retries.
    return { status: 'accepted', fired, ...(duplicate ? { duplicate: true } : {}) };
  }

  /**
   * Per-`(workflow, env)` webhook intake — the ONLY canvas-trigger fire URL.
   * Must stay declared after the literal-first-segment routes above so they keep precedence.
   */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(202)
  @Post(':workflowId/:env')
  async fireEnv(
    @Param('workflowId') workflowId: string,
    @Param('env') env: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    if (!isIdShape(workflowId)) throw new DomainError('Webhook not found', 404);
    const rawBody = (req as { rawBody?: string }).rawBody ?? (body === undefined ? '' : JSON.stringify(body));
    const headers = lowerCaseHeaders(req.headers);
    const { runIds } = await this.triggers.fireWorkflowEnvWebhook(workflowId, env, {
      body,
      rawBody,
      headers,
    });
    // `fired: 0` is a real outcome (deduped / handshake / unmatched); run_id is then null.
    return { status: 'accepted', fired: runIds.length, run_id: runIds[0] ?? null, run_ids: runIds };
  }
}

/** Flatten Express headers to a lower-cased single-value map (what the SDK's WebhookRequest expects). */
function lowerCaseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
