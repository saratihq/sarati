import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Allow, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { isIdShape } from '../database/ids';
import { EnvironmentsService, type ConnectionReference } from '../environments/environments.service';
import { ConnectionsService, type ConnectionSummary, type ConnectionTestResult } from './connections.service';
import { Scope } from '../auth/scope.decorator';
import { PlatformKeysService } from '../platform/platform-keys.service';

class RenameConnectionDto {
  @IsOptional()
  @IsString()
  display_name?: string;
}

class CreateConnectionDto {
  /** The app this account is for — the public slug, e.g. `slack`. */
  @IsString()
  provider!: string;

  /** The credential the action's auth seam expects — a token string or an object. */
  @Allow()
  credential!: unknown;

  @IsOptional()
  @IsString()
  display_name?: string;
}

/** Managed-integration connections. Secrets are never returned. */
@Controller('api/connections')
@UseGuards(AuthGuard)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly environments: EnvironmentsService,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  private userId(req: Request): string {
    return requirePrincipal(req).user.id;
  }

  /** Whether the managed rail is configured — the client keys its connect UI (managed-first vs BYO-only) off this. */
  @Scope('connection:read')
  @Get('capabilities')
  async capabilities(@Req() req: Request): Promise<{ managed_available: boolean }> {
    const principal = requirePrincipal(req);
    const scope = await this.platformKeys.scopeFor(principal.user.id, principal.activeOrgId);
    return { managed_available: await this.connections.managedConfigured(scope) };
  }

  /** Malformed ids can never match a row — 404 before any uuid-typed query 500s. */
  private validId(id: string): string {
    if (!isIdShape(id)) throw new HttpException({ detail: 'Connection not found' }, 404);
    return id;
  }

  @Scope('connection:write')
  @Post()
  create(@Req() req: Request, @Body() body: CreateConnectionDto): Promise<ConnectionSummary> {
    return this.connections.createToken(this.userId(req), {
      provider: body.provider,
      credential: body.credential,
      displayName: body.display_name,
    });
  }

  @Scope('connection:read')
  @Get()
  list(@Req() req: Request): Promise<ConnectionSummary[]> {
    return this.connections.list(this.userId(req));
  }

  /** The environments whose slots reference this connection; ownership-scoped, so a foreign one is a 404. */
  @Scope('connection:read')
  @Get(':id/references')
  async references(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ references: ConnectionReference[] }> {
    this.validId(id);
    const ref = await this.connections.managedRef(this.userId(req), id);
    if (!ref) throw new HttpException({ detail: 'Connection not found' }, 404);
    return { references: await this.environments.referencesOf(id) };
  }

  @Scope('connection:write')
  @Patch(':id')
  async rename(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: RenameConnectionDto,
  ): Promise<ConnectionSummary> {
    this.validId(id);
    const trimmed = body.display_name?.trim() ?? '';
    const renamed = await this.connections.rename(id, this.userId(req), trimmed === '' ? null : trimmed);
    if (!renamed) throw new NotFoundException('Connection not found');
    return renamed;
  }

  /** Refuses with 409 + the references payload while env slots reference it; `?force=true` cascades the slots away. */
  @Scope('connection:write')
  @Delete(':id')
  async remove(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('force') force?: string,
  ): Promise<{ status: string }> {
    this.validId(id);
    const userId = this.userId(req);
    if (force !== 'true') {
      const owned = await this.connections.managedRef(userId, id);
      const references = owned ? await this.environments.referencesOf(id) : [];
      if (references.length > 0) {
        throw new HttpException(
          {
            detail: 'This connection is assigned to environment slots — those runs will fail on it',
            code: 'CONNECTION_IN_USE',
            references,
          },
          409,
        );
      }
    }
    const removed = await this.connections.delete(userId, id);
    if (!removed) throw new HttpException({ detail: 'Connection not found' }, 404);
    return { status: 'deleted' };
  }

  /** Liveness probe, as deep as the auth type honestly allows; throttled because each probe can hit a provider. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Scope('connection:write')
  @Post(':id/test')
  @HttpCode(200)
  async test(@Req() req: Request, @Param('id') id: string): Promise<ConnectionTestResult> {
    const result = await this.connections.test(this.userId(req), id);
    if (!result) throw new HttpException({ detail: 'Connection not found' }, 404);
    return result;
  }
}
