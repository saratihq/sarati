import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal, type Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import type { EnvConfig } from '../config/env.config';
import {
  ASSIGNABLE_ORG_ROLES,
  type AssignableOrgRole,
  type OrganizationEntity,
  type OrgRole,
} from '../database/entities/organization.entity';
import { EMAIL_ADAPTER, type EmailAdapter } from './email.adapter';
import { OrgManagementService, type OrgSummary } from './org-management.service';
import { Scope } from '../auth/scope.decorator';

class CreateOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;
}

class RenameOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;
}

class ChangeRoleDto {
  @IsIn(ASSIGNABLE_ORG_ROLES)
  role!: AssignableOrgRole;
}

class TransferOwnershipDto {
  @IsString()
  user_id!: string;
}

class CreateInviteDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsIn(ASSIGNABLE_ORG_ROLES)
  role?: AssignableOrgRole;
}

/** Org administration; role POLICY lives here (members read, owners/admins manage, owners assign roles). */
@Controller('api/orgs')
@UseGuards(AuthGuard)
export class OrgsController {
  private readonly logger = new Logger(OrgsController.name);

  constructor(
    private readonly mgmt: OrgManagementService,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    @Inject(EMAIL_ADAPTER) private readonly email: EmailAdapter,
  ) {}

  @Scope('workflow:read')
  @Get()
  async list(@Req() req: Request): Promise<{ orgs: OrgSummary[] }> {
    return { orgs: await this.mgmt.listOrgs(requirePrincipal(req).user.id) };
  }

  @Scope('org:manage')
  @Post()
  async create(@Req() req: Request, @Body() body: CreateOrgDto): Promise<OrgSummary> {
    return this.mgmt.createOrg(requirePrincipal(req).user.id, body.name);
  }

  /** Accept is token-bound (not email-bound) — any logged-in account holding the link joins. */
  @HttpCode(200)
  @Scope('org:manage')
  @Post('invites/:token/accept')
  async accept(
    @Req() req: Request,
    @Param('token') token: string,
  ): Promise<{ org_id: string; name: string }> {
    return this.mgmt.acceptInvite(requirePrincipal(req).user.id, token);
  }

  @Scope('org:manage')
  @Patch(':id')
  async rename(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Body() body: RenameOrgDto,
  ): Promise<OrgSummary> {
    const principal = requirePrincipal(req);
    const { org, role } = await this.requireManager(orgId, principal);
    return this.mgmt.renameOrg(org, principal.user.id, role, body.name);
  }

  /** Delete a whole organization — owner-only; refuses while workflows remain. */
  @Scope('org:manage')
  @Delete(':id')
  async deleteOrg(@Req() req: Request, @Param('id') orgId: string): Promise<{ status: string }> {
    const principal = requirePrincipal(req);
    const { org, role } = await this.requireMember(orgId, principal);
    if (role !== 'owner') throw new DomainError('Only an owner can delete the organization', 403);
    await this.mgmt.deleteOrg(org, principal.user.id);
    return { status: 'deleted' };
  }

  @Scope('org:manage')
  @Get(':id/members')
  async members(
    @Req() req: Request,
    @Param('id') orgId: string,
  ): Promise<{ members: Array<Record<string, unknown>> }> {
    const { org } = await this.requireMember(orgId, requirePrincipal(req));
    return { members: await this.mgmt.listMembers(org.id) };
  }

  @Scope('org:manage')
  @Patch(':id/members/:userId')
  async changeRole(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Param('userId') userId: string,
    @Body() body: ChangeRoleDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    const { org, role } = await this.requireMember(orgId, principal);
    if (role !== 'owner') throw new DomainError('Only owners can change member roles', 403);
    return this.mgmt.changeRole(org.id, principal.user.id, userId, body.role);
  }

  /** Hand off ownership: caller (an owner) steps down to admin, target becomes owner. */
  @Scope('org:manage')
  @Post(':id/transfer-ownership')
  async transferOwnership(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Body() body: TransferOwnershipDto,
  ): Promise<OrgSummary> {
    const principal = requirePrincipal(req);
    const { org, role } = await this.requireMember(orgId, principal);
    if (role !== 'owner') throw new DomainError('Only an owner can transfer ownership', 403);
    return this.mgmt.transferOwnership(org, principal.user.id, body.user_id);
  }

  @Scope('org:manage')
  @Delete(':id/members/:userId')
  async removeMember(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Param('userId') userId: string,
  ): Promise<{ status: string }> {
    const principal = requirePrincipal(req);
    const isSelf = userId === principal.user.id;
    // Anyone may remove THEMSELVES (leave); removing others is owner/admin.
    if (isSelf) await this.requireMember(orgId, principal);
    else await this.requireManager(orgId, principal);
    await this.mgmt.removeMember(orgId, principal.user.id, userId);
    return { status: isSelf ? 'left' : 'removed' };
  }

  @Scope('org:manage')
  @Get(':id/invites')
  async invites(
    @Req() req: Request,
    @Param('id') orgId: string,
  ): Promise<{ invites: Array<Record<string, unknown>> }> {
    const { org } = await this.requireManager(orgId, requirePrincipal(req));
    return { invites: await this.mgmt.listInvites(org.id) };
  }

  @Scope('org:manage')
  @Post(':id/invites')
  async invite(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Body() body: CreateInviteDto,
  ): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    const { org } = await this.requireManager(orgId, principal);
    const invite = await this.mgmt.createInvite(org, principal.user.id, body.email, body.role ?? 'member');

    // The token is in the response either way, so a failing mail provider must not fail the invite.
    const env = this.config.get('env', { infer: true });
    try {
      await this.email.sendOrgInvite({
        to: invite.email,
        orgName: org.name,
        role: invite.role,
        inviteLink: `${env.frontendUrl.replace(/\/$/, '')}/join/${invite.token}`,
      });
    } catch (err) {
      this.logger.warn(`Invite email for ${invite.email} failed: ${String(err)}`);
    }

    return { id: invite.id, email: invite.email, role: invite.role, token: invite.token };
  }

  @Scope('org:manage')
  @Delete(':id/invites/:inviteId')
  async revokeInvite(
    @Req() req: Request,
    @Param('id') orgId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<{ status: string }> {
    const principal = requirePrincipal(req);
    const { org } = await this.requireManager(orgId, principal);
    await this.mgmt.revokeInvite(org.id, principal.user.id, inviteId);
    return { status: 'revoked' };
  }

  /** 404 unknown org; 403 non-member (an org's existence is not probeable). */
  private async requireMember(
    orgId: string,
    principal: Principal,
  ): Promise<{ org: OrganizationEntity; role: OrgRole }> {
    const org = await this.mgmt.orgById(orgId);
    const membership = await this.mgmt.membershipOf(org.id, principal.user.id);
    if (!membership) throw new DomainError('Not a member of this organization', 403);
    return { org, role: membership.role };
  }

  private async requireManager(
    orgId: string,
    principal: Principal,
  ): Promise<{ org: OrganizationEntity; role: OrgRole }> {
    const found = await this.requireMember(orgId, principal);
    if (found.role !== 'owner' && found.role !== 'admin') {
      throw new DomainError('Only owners and admins can manage this organization', 403);
    }
    return found;
  }
}
