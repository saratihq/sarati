import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import type { OrgRole } from '../database/entities/organization.entity';
import { OrgMemberEntity } from '../database/entities/organization.entity';
import type { Principal } from '../auth/principal';

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

/** The single authorization point (ADR 0037): routes ask `can(...)` — never compare user ids inline. */
@Injectable()
export class PolicyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async can(principal: Principal, action: PolicyAction, subject: PolicySubject): Promise<boolean> {
    const userId = principal.user.id;

    if (subject.orgId) {
      const member = await this.dataSource.manager.findOne(OrgMemberEntity, {
        where: { orgId: subject.orgId, userId },
      });
      if (member && ROLE_ALLOWS[member.role]?.has(action)) return true;
    }

    // Direct-ownership fallback; NULL owner + NULL org must DENY (never public).
    if (subject.ownerUserId) return subject.ownerUserId === userId;
    return false;
  }
}
