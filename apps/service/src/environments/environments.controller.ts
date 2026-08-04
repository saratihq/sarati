import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { EnvironmentsService, type EnvironmentView } from './environments.service';
import { Scope } from '../auth/scope.decorator';

class CreateEnvironmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

class RenameEnvironmentDto extends CreateEnvironmentDto {}

class AssignSlotDto {
  @IsUUID()
  connection_id!: string;
}

/** App slugs, one vocabulary with action/trigger public types (`slack`, `gmail`, …). */
const APP_SHAPE = /^[a-z][a-z0-9_-]{0,119}$/;

/** Env lifecycle + slot curation (ADR 0014) for the active org: reads need membership, writes owner/admin. */
@Controller('api/environments')
@UseGuards(AuthGuard)
export class EnvironmentsController {
  constructor(private readonly environments: EnvironmentsService) {}

  @Scope('workflow:read')
  @Get()
  async list(@Req() req: Request): Promise<{ environments: EnvironmentView[] }> {
    const { orgId } = this.member(req);
    return { environments: await this.environments.list(orgId) };
  }

  @Scope('workflow:deploy')
  @Post()
  create(@Req() req: Request, @Body() body: CreateEnvironmentDto): Promise<{ id: string; name: string }> {
    const { orgId, userId } = this.manager(req);
    return this.environments.create(orgId, body.name, userId);
  }

  @Scope('workflow:deploy')
  @Patch(':id')
  rename(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: RenameEnvironmentDto,
  ): Promise<{ id: string; name: string }> {
    const { orgId, userId } = this.manager(req);
    return this.environments.rename(orgId, id, body.name, userId);
  }

  @Scope('workflow:deploy')
  @Delete(':id')
  remove(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ removed_pointers: number; unbound_triggers: number }> {
    const { orgId, userId } = this.manager(req);
    return this.environments.remove(orgId, id, userId);
  }

  /** Assign/replace a slot: (env, app) → one of the caller's pool connections. */
  @Scope('connection:write')
  @Put(':id/slots/:app')
  assignSlot(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('app') app: string,
    @Body() body: AssignSlotDto,
  ): Promise<{ replaced_connection_id: string | null; also_in_environments: string[] }> {
    const { orgId, userId } = this.manager(req);
    return this.environments.assignSlot(orgId, id, this.validApp(app), body.connection_id, userId);
  }

  @Scope('connection:write')
  @Delete(':id/slots/:app')
  async emptySlot(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('app') app: string,
  ): Promise<{ removed: true }> {
    const { orgId } = this.manager(req);
    await this.environments.emptySlot(orgId, id, this.validApp(app));
    return { removed: true };
  }

  /** Membership is already guard-validated (X-Org-Id 403s non-members). */
  private member(req: Request): { orgId: string; userId: string } {
    const principal = requirePrincipal(req);
    if (!principal.activeOrgId) {
      throw new DomainError('Environments need a workspace — no active organization resolved', 400);
    }
    return { orgId: principal.activeOrgId, userId: principal.user.id };
  }

  /** Curation writes are owner/admin-gated (a personal org's owner is the user). */
  private manager(req: Request): { orgId: string; userId: string } {
    const scope = this.member(req);
    const role = requirePrincipal(req).activeOrgRole;
    if (role !== 'owner' && role !== 'admin') {
      throw new DomainError('Only owners and admins can manage environments', 403);
    }
    return scope;
  }

  private validApp(app: string): string {
    if (!APP_SHAPE.test(app)) throw new DomainError('Invalid app slug', 400);
    return app;
  }
}
