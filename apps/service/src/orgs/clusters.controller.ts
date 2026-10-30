import { Controller, Delete, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { KEY_SCOPED_TO_OTHER_ORG, reachesOrg, requirePrincipal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import type { OrganizationEntity } from '../database/entities/organization.entity';
import { ConnectionsService } from '../connections/connections.service';
import { OrgManagementService } from './org-management.service';
import { Scope } from '../auth/scope.decorator';

/** The per-env CLUSTER connections an earlier release made (owner/admin): listed and deleted, never made. */
@Controller('api/orgs/:id/clusters')
@UseGuards(AuthGuard)
export class ClustersController {
  constructor(
    private readonly mgmt: OrgManagementService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Every cluster connection in the org (each carries its environment). */
  @Scope('connection:read')
  @Get()
  async list(@Req() req: Request, @Param('id') orgId: string): Promise<{ clusters: unknown[] }> {
    const org = await this.requireManager(orgId, req);
    return { clusters: await this.connections.listClusters(org.id) };
  }

  /** Remove a cluster connection (org-scoped). */
  @Scope('connection:write')
  @Delete('connections/:connId')
  async remove(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Param('connId') connId: string,
  ): Promise<{ status: string }> {
    const org = await this.requireManager(orgId, req);
    const removed = await this.connections.deleteCluster(org.id, connId);
    if (!removed) throw new DomainError('Cluster connection not found', 404);
    return { status: 'deleted' };
  }

  /** Owner/admin of a non-personal org — clusters are shared org infrastructure. */
  private async requireManager(orgId: string, req: Request): Promise<OrganizationEntity> {
    const principal = requirePrincipal(req);
    const org = await this.mgmt.orgById(orgId);
    if (org.isPersonal) throw new DomainError('Personal workspaces have no connection clusters', 400);
    const membership = await this.mgmt.membershipOf(org.id, principal.user.id);
    if (!membership) throw new DomainError('Not a member of this organization', 403);
    if (!reachesOrg(principal, org.id)) throw new DomainError(KEY_SCOPED_TO_OTHER_ORG, 403);
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new DomainError('Only owners and admins can manage connection clusters', 403);
    }
    return org;
  }
}
