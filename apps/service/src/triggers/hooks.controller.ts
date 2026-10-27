import { Body, Controller, HttpCode, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { DomainError } from '../common/domain-error';
import { CapabilityPath } from '../common/request-log-redaction';
import { isIdShape } from '../database/ids';
import { HOOKS_PREFIX } from './canvas/webhook-url';
import { CatchStore } from './catch-store';
import { TriggersService, type InboundWebhook } from './triggers.service';

/**
 * Public webhook intake — NO auth guard: the unguessable path is the capability token.
 * The run is fire-and-forget (202 + run_id); poll run history for the outcome.
 */
@Controller(HOOKS_PREFIX)
export class HooksController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly catches: CatchStore,
  ) {}

  /** Test-event intake: the payload becomes an editor sample — nothing runs. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @CapabilityPath()
  @Post('catch/:catchId')
  catchEvent(@Param('catchId') catchId: string, @Body() body: unknown): Record<string, unknown> {
    if (!isIdShape(catchId)) throw new DomainError('Catch not found or expired', 404);
    this.catches.receive(catchId, body);
    return { status: 'caught' };
  }

  /**
   * The GENERIC Composio trigger intake — one endpoint for every projected trigger
   * type. No auth guard: the Svix signature IS the capability (unverified → 401).
   */
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @HttpCode(202)
  @Post('composio')
  async fireComposio(
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<Record<string, unknown>> {
    const { fired, duplicate } = await this.triggers.fireComposioDelivery(inboundOf(body, req));
    // A duplicate is a SUCCESSFUL ack — an error here would only beget more retries.
    return { status: 'accepted', fired, ...(duplicate ? { duplicate: true } : {}) };
  }

  /**
   * Per-`(workflow, env)` webhook intake — the ONLY canvas-trigger fire URL.
   * Must stay declared after the literal-first-segment routes above so they keep precedence.
   */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(202)
  @CapabilityPath()
  @Post(':workflowId/:env')
  async fireEnv(
    @Param('workflowId') workflowId: string,
    @Param('env') env: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<Record<string, unknown>> {
    if (!isIdShape(workflowId)) throw new DomainError('Webhook not found', 404);
    const { runIds } = await this.triggers.fireWorkflowEnvWebhook(workflowId, env, inboundOf(body, req));
    // `fired: 0` is a real outcome (deduped / handshake / unmatched); run_id is then null.
    return { status: 'accepted', fired: runIds.length, run_id: runIds[0] ?? null, run_ids: runIds };
  }
}

// Fails closed: with no raw body a signature is checked over no bytes, never over a re-serialized body.
function inboundOf(body: unknown, req: RawBodyRequest<Request>): InboundWebhook {
  return { body, rawBody: req.rawBody ?? Buffer.alloc(0), headers: lowerCaseHeaders(req.headers) };
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
