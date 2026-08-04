import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { CatchStore } from './catch-store';
import { Scope } from '../auth/scope.decorator';

/**
 * Owner side of the test-event inbox: mint a catch, poll it. The public intake lives on
 * HooksController (`POST /api/hooks/catch/:catchId`) — third parties never authenticate.
 */
@Controller('api/catch')
@UseGuards(AuthGuard)
export class CatchController {
  constructor(private readonly store: CatchStore) {}

  private userId(req: Request): string {
    return requirePrincipal(req).user.id;
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('workflow:write')
  @Post()
  create(@Req() req: Request): Record<string, unknown> {
    const { catchId, expiresAt } = this.store.create(this.userId(req));
    return { catch_id: catchId, path: `/api/hooks/catch/${catchId}`, expires_at: expiresAt };
  }

  @Throttle({ default: { limit: 240, ttl: 60_000 } }) // the picker polls ~every 2s
  @Scope('workflow:read')
  @Get(':catchId')
  read(@Req() req: Request, @Param('catchId') catchId: string): Record<string, unknown> {
    return this.store.read(catchId, this.userId(req));
  }
}
