import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import type { OrgRole } from '../database/entities/organization.entity';
import { OrgMemberEntity } from '../database/entities/organization.entity';
import { reachesOrg, type Principal } from '../auth/principal';

export type PolicyAction = 'read' | 'write' | 'deploy' | 'merge' | 'manage';

export interface PolicySubject {
  orgId?: string | null;
  /** Legacy single-owner column — coexistence fallback while org_id backfills. */
  ownerUserId?: string | null;
}

const ROLE_ALLOWS: Record<OrgRole, ReadonlySet<PolicyAction>> = {
  owner: new Set(['read', 'write', 'deploy', 'merge', 'manage']),
  admin: new Set(['read', 'write', 'deploy', 'merge', 'manage']),
  // 'member' gets everything workflow-related; org administration stays owner/admin-only.
  member: new Set(['read', 'write', 'deploy', 'merge']),
  editor: new Set(['read', 'write', 'deploy', 'merge']),
  viewer: new Set(['read']),
};

/** The single authorization point: routes ask `can(...)` — never compare user ids inline. */
@Injectable()
export class PolicyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async can(principal: Principal, action: PolicyAction, subject: PolicySubject): Promise<boolean> {
    const userId = principal.user.id;
    if (!reachesOrg(principal, subject.orgId ?? null)) return false;

    if (subject.orgId) {
      const member = await this.dataSource.manager.findOne(OrgMemberEntity, {
        where: { orgId: subject.orgId, userId },
      });
      return member !== null && ROLE_ALLOWS[member.role]?.has(action) === true;
    }

    // Org-less rows only: once a subject has an org, membership decides, so leaving the org ends access.
    if (subject.ownerUserId) return subject.ownerUserId === userId;
    return false;
  }

  /** The orgs this principal may act in at all: its current memberships, narrowed to a key's pin. */
  async reachableOrgIds(principal: Principal): Promise<string[]> {
    const memberships = await this.dataSource.manager.find(OrgMemberEntity, {
      where: { userId: principal.user.id },
      select: { orgId: true },
    });
    return memberships.map((m) => m.orgId).filter((orgId) => reachesOrg(principal, orgId));
  }
}
