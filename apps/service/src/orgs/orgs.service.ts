import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape, newId, now } from '../database/ids';
import { OrgMemberEntity, OrganizationEntity, type OrgRole } from '../database/entities/organization.entity';
import type { UserEntity } from '../database/entities/user.entity';

export interface ActiveOrg {
  orgId: string | null;
  role: OrgRole | null;
}

/** Tenancy primitive (ADR 0037): every user has exactly one personal org, on the same tables as real orgs. */
@Injectable()
export class OrgsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Idempotent: returns the user's personal org, creating org + owner membership if absent. */
  async ensurePersonalOrg(em: EntityManager, user: UserEntity): Promise<OrganizationEntity> {
    const existing = await em
      .createQueryBuilder(OrganizationEntity, 'org')
      .innerJoin(OrgMemberEntity, 'm', 'm.org_id = org.id')
      .where('m.user_id = :userId', { userId: user.id })
      .andWhere('org.is_personal = true')
      .getOne();
    if (existing) return existing;

    const org = em.create(OrganizationEntity, {
      id: newId(),
      name: user.name,
      isPersonal: true,
      createdAt: now(),
      updatedAt: now(),
    });
    await em.insert(OrganizationEntity, org);
    await em.insert(OrgMemberEntity, {
      id: newId(),
      orgId: org.id,
      userId: user.id,
      role: 'owner',
      createdAt: now(),
    });
    return org;
  }

  async roleOf(em: EntityManager, userId: string, orgId: string): Promise<OrgRole | null> {
    const member = await em.findOne(OrgMemberEntity, { where: { userId, orgId } });
    return member?.role ?? null;
  }

  async nameOf(orgId: string): Promise<string | null> {
    const org = await this.dataSource.manager.findOne(OrganizationEntity, { where: { id: orgId } });
    return org?.name ?? null;
  }

  async personalOrgOf(em: EntityManager, userId: string): Promise<OrganizationEntity | null> {
    return em
      .createQueryBuilder(OrganizationEntity, 'org')
      .innerJoin(OrgMemberEntity, 'm', 'm.org_id = org.id')
      .where('m.user_id = :userId', { userId })
      .andWhere('org.is_personal = true')
      .getOne();
  }

  /** Active org for the request: `X-Org-Id` must be one the caller belongs to (403), else the personal org. */
  async resolveActiveOrg(userId: string, requestedOrgId: string | undefined): Promise<ActiveOrg> {
    const em = this.dataSource.manager;
    const requested = requestedOrgId?.trim();
    if (requested) {
      const member = isIdShape(requested)
        ? await em.findOne(OrgMemberEntity, { where: { orgId: requested, userId } })
        : null;
      if (!member) throw new DomainError('Not a member of this organization', 403);
      return { orgId: member.orgId, role: member.role };
    }
    const personal = await this.personalOrgOf(em, userId);
    // Personal-org membership is 'owner' by construction (ensurePersonalOrg).
    return personal ? { orgId: personal.id, role: 'owner' } : { orgId: null, role: null };
  }
}
