import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { OrgMemberEntity, OrganizationEntity, type OrgRole } from '../database/entities/organization.entity';
import type { UserEntity } from '../database/entities/user.entity';

import { insertOrg } from './insert-org';

export interface ActiveOrg {
  orgId: string | null;
  role: OrgRole | null;
}

/** Tenancy primitive: every user has exactly one personal org, its one member, on the same tables as real orgs (constitution row 22). */
@Injectable()
export class OrgsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Idempotent: returns the user's personal org, creating org + owner membership + default environments if absent. */
  async ensurePersonalOrg(em: EntityManager, user: UserEntity): Promise<OrganizationEntity> {
    const existing = await this.personalOrgOf(em, user.id);
    if (existing) return existing;
    return insertOrg(em, { name: user.name, isPersonal: true, ownerId: user.id });
  }

  async roleOf(em: EntityManager, userId: string, orgId: string): Promise<OrgRole | null> {
    return (await this.membership(em, orgId, userId))?.role ?? null;
  }

  async nameOf(orgId: string): Promise<string | null> {
    const org = await this.dataSource.manager.findOne(OrganizationEntity, { where: { id: orgId } });
    return org?.name ?? null;
  }

  /** THE answer to "which is this user's personal org": the one that belongs to the user, never one they are merely a member of. */
  async personalOrgOf(em: EntityManager, userId: string): Promise<OrganizationEntity | null> {
    return em.findOne(OrganizationEntity, { where: { personalOwnerId: userId } });
  }

  /** Active org for the request: `X-Org-Id` must be one the caller belongs to (403), else the personal org; the role is always the stored one. */
  async resolveActiveOrg(userId: string, requestedOrgId: string | undefined): Promise<ActiveOrg> {
    const em = this.dataSource.manager;
    const requested = requestedOrgId?.trim();
    if (requested) {
      const member = isIdShape(requested) ? await this.membership(em, requested, userId) : null;
      if (!member) throw new DomainError('Not a member of this organization', 403);
      return { orgId: member.orgId, role: member.role };
    }
    const personal = await this.personalOrgOf(em, userId);
    const member = personal ? await this.membership(em, personal.id, userId) : null;
    return member ? { orgId: member.orgId, role: member.role } : { orgId: null, role: null };
  }

  private membership(em: EntityManager, orgId: string, userId: string): Promise<OrgMemberEntity | null> {
    return em.findOne(OrgMemberEntity, { where: { orgId, userId } });
  }
}
