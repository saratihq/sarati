import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { ManagedConnectionsService, type ManagedApp } from './managed-connections.service';
import { Scope } from '../auth/scope.decorator';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';

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
  constructor(
    private readonly managed: ManagedConnectionsService,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  private userId(req: Request): string {
    return requirePrincipal(req).user.id;
  }

  /** Whose Composio key brokers this request — the caller's active context. */
  private scope(req: Request): Promise<PlatformKeyScope> {
    const principal = requirePrincipal(req);
    return this.platformKeys.scopeFor(principal.user.id, principal.activeOrgId);
  }

  /** Apps offered for one-click connect (app catalog ∩ Composio managed toolkits). */
  @Scope('connection:read')
  @Get('managed/apps')
  async listApps(@Req() req: Request, @Query('q') q?: string): Promise<{ apps: ManagedApp[] }> {
    return { apps: await this.managed.listApps(await this.scope(req), q) };
  }

  /** Start a connect: a PENDING connection + the hosted link the client opens. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('connection:write')
  @Post('managed/link')
  async createLink(
    @Req() req: Request,
    @Body() body: ManagedLinkDto,
  ): Promise<{ connection_id: string; redirect_url: string }> {
    const { connectionId, redirectUrl } = await this.managed.createLink(
      await this.scope(req),
      this.userId(req),
      body.app,
    );
    return { connection_id: connectionId, redirect_url: redirectUrl };
  }

  /** Lifecycle poll: pending until the user completes the hosted flow, then active. */
  @Scope('connection:read')
  @Get(':id/status')
  async status(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ status: 'pending' | 'active' | 'failed' }> {
    return { status: await this.managed.status(await this.scope(req), this.userId(req), id) };
  }
}
