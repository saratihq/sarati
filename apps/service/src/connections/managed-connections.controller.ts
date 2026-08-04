import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { ManagedConnectionsService, type ManagedApp } from './managed-connections.service';
import { Scope } from '../auth/scope.decorator';

class ManagedLinkDto {
  /** App slug from GET /api/connections/managed/apps, e.g. `slack`. */
  @IsString()
  @IsNotEmpty()
  app!: string;
}

/** Managed (Composio-brokered) connections: list apps, mint a hosted connect link, poll lifecycle status. */
@Controller('api/connections')
@UseGuards(AuthGuard)
export class ManagedConnectionsController {
  constructor(private readonly managed: ManagedConnectionsService) {}

  private userId(req: Request): string {
    return requirePrincipal(req).user.id;
  }

  /** Apps offered for one-click connect (app catalog ∩ Composio managed toolkits). */
  @Scope('connection:read')
  @Get('managed/apps')
  async listApps(@Query('q') q?: string): Promise<{ apps: ManagedApp[] }> {
    return { apps: await this.managed.listApps(q) };
  }

  /** Start a connect: a PENDING connection + the hosted link the client opens. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('connection:write')
  @Post('managed/link')
  async createLink(
    @Req() req: Request,
    @Body() body: ManagedLinkDto,
  ): Promise<{ connection_id: string; redirect_url: string }> {
    const { connectionId, redirectUrl } = await this.managed.createLink(this.userId(req), body.app);
    return { connection_id: connectionId, redirect_url: redirectUrl };
  }

  /** Lifecycle poll: pending until the user completes the hosted flow, then active. */
  @Scope('connection:read')
  @Get(':id/status')
  async status(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ status: 'pending' | 'active' | 'failed' }> {
    return { status: await this.managed.status(this.userId(req), id) };
  }
}
