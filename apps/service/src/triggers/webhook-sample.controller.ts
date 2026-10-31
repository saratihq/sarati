import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthGuard } from '../auth/auth.guard';
import { Scope } from '../auth/scope.decorator';
import { WEBHOOK_SAMPLE_PATH } from './canvas/webhook-url';
import { coerceWebhookBody } from './triggers.service';

/** A pasted sample event, read as a webhook delivery's body and shaped as the trigger its run would see. Nothing is stored. */
@Controller(WEBHOOK_SAMPLE_PATH)
@UseGuards(AuthGuard)
export class WebhookSampleController {
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('workflow:write')
  @HttpCode(200)
  @Post()
  shape(@Body() body: unknown): Record<string, unknown> {
    return { payload: coerceWebhookBody(body) };
  }
}
