import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal, type Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import type { OrganizationEntity } from '../database/entities/organization.entity';
import { ConnectionsService } from '../connections/connections.service';
import { ManagedConnectionsService } from '../connections/managed-connections.service';
import { OrgManagementService } from './org-management.service';
import { Scope } from '../auth/scope.decorator';

class ConnectClusterDto {
  /** App slug to connect for this environment's cluster (managed apps only). */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  app!: string;
}

const ENV_SHAPE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

/** Per-env connection CLUSTERS (owner/admin): one managed account per `(org, env, app)`, run AS its owner. */
@Controller('api/orgs/:id/clusters')
@UseGuards(AuthGuard)
export class ClustersController {
  constructor(
    private readonly mgmt: OrgManagementService,
    private readonly managed: ManagedConnectionsService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Every cluster connection in the org (each carries its environment). */
  @Scope('connection:read')
  @Get()
  async list(@Req() req: Request, @Param('id') orgId: string): Promise<{ clusters: unknown[] }> {
    const { org } = await this.requireManager(orgId, req);
    return { clusters: await this.connections.listClusters(org.id) };
  }

  /** Start a managed connect for `app` in `env` — tagged to the org's env cluster. */
  @Scope('connection:write')
  @Post(':env/connect')
  async connect(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Param('env') env: string,
    @Body() body: ConnectClusterDto,
  ): Promise<{ connection_id: string; redirect_url: string }> {
    const { org, principal } = await this.requireManager(orgId, req);
    if (!ENV_SHAPE.test(env)) throw new DomainError('Invalid environment name', 400);
    const { connectionId, redirectUrl } = await this.managed.createClusterLink(
      principal.user.id,
      org.id,
      env,
      body.app,
    );
    return { connection_id: connectionId, redirect_url: redirectUrl };
  }

  /** Remove a cluster connection (org-scoped). */
  @Scope('connection:write')
  @Delete('connections/:connId')
  async remove(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Param('connId') connId: string,
  ): Promise<{ status: string }> {
    const { org } = await this.requireManager(orgId, req);
    const removed = await this.connections.deleteCluster(org.id, connId);
    if (!removed) throw new DomainError('Cluster connection not found', 404);
    return { status: 'deleted' };
  }

  /** Owner/admin of a non-personal org — clusters are shared org infrastructure. */
  private async requireManager(
    orgId: string,
    req: Request,
  ): Promise<{ org: OrganizationEntity; principal: Principal }> {
    const principal = requirePrincipal(req);
    const org = await this.mgmt.orgById(orgId);
    if (org.isPersonal) throw new DomainError('Personal workspaces have no connection clusters', 400);
    const membership = await this.mgmt.membershipOf(org.id, principal.user.id);
    if (!membership) throw new DomainError('Not a member of this organization', 403);
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new DomainError('Only owners and admins can manage connection clusters', 403);
    }
    return { org, principal };
  }
}
