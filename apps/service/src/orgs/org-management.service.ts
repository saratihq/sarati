import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape, newId, now } from '../database/ids';
import { OrgInviteEntity } from '../database/entities/org-invite.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { ConnectionsService } from '../connections/connections.service';
import {
  OrgMemberEntity,
  OrganizationEntity,
  type AssignableOrgRole,
  type OrgRole,
} from '../database/entities/organization.entity';
import { rawQuery } from '../database/raw-query';
import { EventsService } from '../events/events.service';

const INVITE_TTL_DAYS = 14;
const PG_UNIQUE_VIOLATION = '23505';

export interface OrgSummary {
  id: string;
  name: string;
  is_personal: boolean;
  role: OrgRole;
}

/** Org administration; owns the invariants (never zero owners, invites are single-use) — role policy is the controller's. */
@Injectable()
export class OrgManagementService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly connections: ConnectionsService,
  ) {}

  /** The caller's memberships, personal org first (client contract). */
  async listOrgs(userId: string): Promise<OrgSummary[]> {
    const rows = await rawQuery<{ id: string; name: string; is_personal: boolean; role: OrgRole }>(
      this.dataSource.manager,
      `SELECT o.id, o.name, o.is_personal, m.role
         FROM organizations o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.is_personal DESC, o.created_at ASC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, is_personal: r.is_personal, role: r.role }));
  }

  async createOrg(actorId: string, name: string): Promise<OrgSummary> {
    return this.dataSource.transaction(async (em) => {
      const org = em.create(OrganizationEntity, {
        id: newId(),
        name,
        isPersonal: false,
        createdAt: now(),
        updatedAt: now(),
      });
      await em.insert(OrganizationEntity, org);
      await em.insert(OrgMemberEntity, {
        id: newId(),
        orgId: org.id,
        userId: actorId,
        role: 'owner',
        createdAt: now(),
      });
      await this.events.emit(em, {
        orgId: org.id,
        actorUserId: actorId,
        type: 'org.created',
        subjectType: 'organization',
        subjectId: org.id,
        payload: { name },
      });
      return { id: org.id, name: org.name, is_personal: false, role: 'owner' as const };
    });
  }

  async renameOrg(
    org: OrganizationEntity,
    actorId: string,
    actorRole: OrgRole,
    name: string,
  ): Promise<OrgSummary> {
    if (org.isPersonal) throw new DomainError('The personal organization cannot be renamed');
    return this.dataSource.transaction(async (em) => {
      const previous = org.name;
      await em.update(OrganizationEntity, { id: org.id }, { name, updatedAt: now() });
      await this.events.emit(em, {
        orgId: org.id,
        actorUserId: actorId,
        type: 'org.renamed',
        subjectType: 'organization',
        subjectId: org.id,
        payload: { name, previous_name: previous },
      });
      return { id: org.id, name, is_personal: org.isPersonal, role: actorRole };
    });
  }

  /** Delete a non-personal org; refuses while workflows remain, memberships/invites/keys cascade. */
  async deleteOrg(org: OrganizationEntity, actorId: string): Promise<void> {
    if (org.isPersonal) throw new DomainError('The personal organization cannot be deleted');
    // Refuse while workflows remain (they'd be orphaned via the SET-NULL FK).
    const workflows = await this.dataSource.manager.count(WorkflowEntity, { where: { orgId: org.id } });
    if (workflows > 0) {
      throw new DomainError(
        `This organization still has ${workflows} workflow${workflows === 1 ? '' : 's'} — move or delete them before deleting the organization.`,
        409,
      );
    }
    // Tear down cluster connections FIRST: no FK, so the org delete would orphan live third-party grants.
    const clusters = await this.connections.listClusters(org.id);
    for (const c of clusters) await this.connections.deleteCluster(org.id, c.id);

    await this.dataSource.transaction(async (em) => {
      await this.events.emit(em, {
        orgId: org.id,
        actorUserId: actorId,
        type: 'org.deleted',
        subjectType: 'organization',
        subjectId: org.id,
        payload: { name: org.name },
      });
      await em.delete(OrganizationEntity, { id: org.id });
    });
  }

  async listMembers(orgId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await rawQuery<{
      user_id: string;
      email: string;
      name: string;
      role: OrgRole;
      joined_at: Date | null;
    }>(
      this.dataSource.manager,
      `SELECT m.user_id, u.email, u.name, m.role, m.created_at AS joined_at
         FROM org_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1
        ORDER BY m.created_at ASC`,
      [orgId],
    );
    return rows.map((r) => ({
      user_id: r.user_id,
      email: r.email,
      name: r.name,
      role: r.role,
      joined_at: r.joined_at ? new Date(r.joined_at).toISOString() : null,
    }));
  }

  async changeRole(
    orgId: string,
    actorId: string,
    targetUserId: string,
    role: AssignableOrgRole,
  ): Promise<Record<string, unknown>> {
    return this.dataSource.transaction(async (em) => {
      const target = await this.memberForUpdate(em, orgId, targetUserId);
      if (target.role === 'owner' && role !== 'owner' && (await this.ownerCount(em, orgId)) <= 1) {
        throw new DomainError('Cannot demote the last owner');
      }
      // Env steps run AS the connection owner, so demoting a member who still holds one strands them.
      if (role === 'member' && target.role !== 'member') {
        const strandCount = await this.countMemberOrgConnections(em, orgId, targetUserId);
        if (strandCount > 0) {
          throw new DomainError(
            `This member owns ${strandCount} connection(s) that the organization's environments rely on — reconnect them as another owner/admin, reassign the slot, or remove them, before demoting to member.`,
            409,
          );
        }
      }
      const previous = target.role;
      await em.update(OrgMemberEntity, { id: target.id }, { role });
      if (previous !== role) {
        await this.events.emit(em, {
          orgId,
          actorUserId: actorId,
          type: 'org.member_role_changed',
          subjectType: 'org_member',
          subjectId: targetUserId,
          payload: { user_id: targetUserId, role, previous_role: previous },
        });
      }
      return { user_id: targetUserId, role };
    });
  }

  /** The ONLY way ownership moves: target → owner, actor → admin in one transaction (role edits never mint an owner). */
  async transferOwnership(
    org: OrganizationEntity,
    actorId: string,
    targetUserId: string,
  ): Promise<OrgSummary> {
    if (org.isPersonal) throw new DomainError('The personal organization has no other members');
    if (actorId === targetUserId) throw new DomainError('You are already the owner');
    return this.dataSource.transaction(async (em) => {
      // Lock both membership rows in sorted order so a concurrent transfer on the same pair can't deadlock.
      const firstId = actorId < targetUserId ? actorId : targetUserId;
      const secondId = actorId < targetUserId ? targetUserId : actorId;
      const first = await this.memberForUpdate(em, org.id, firstId);
      const second = await this.memberForUpdate(em, org.id, secondId);
      const actor = first.userId === actorId ? first : second;
      const target = first.userId === targetUserId ? first : second;
      if (actor.role !== 'owner') throw new DomainError('Only an owner can transfer ownership', 403);

      // Promote first (org now has 2 owners), then demote self — never zero owners.
      await em.update(OrgMemberEntity, { id: target.id }, { role: 'owner' });
      await em.update(OrgMemberEntity, { id: actor.id }, { role: 'admin' });
      await this.events.emit(em, {
        orgId: org.id,
        actorUserId: actorId,
        type: 'org.ownership_transferred',
        subjectType: 'org_member',
        subjectId: targetUserId,
        payload: { new_owner: targetUserId, previous_owner: actorId },
      });
      return { id: org.id, name: org.name, is_personal: org.isPersonal, role: 'admin' as const };
    });
  }

  /** `isSelf` = leave (any role may, except the last owner); otherwise a removal by owner/admin. */
  async removeMember(orgId: string, actorId: string, targetUserId: string): Promise<void> {
    const isSelf = actorId === targetUserId;
    await this.dataSource.transaction(async (em) => {
      const target = await this.memberForUpdate(em, orgId, targetUserId);
      if (target.role === 'owner' && (await this.ownerCount(em, orgId)) <= 1) {
        throw new DomainError(
          isSelf ? 'The last owner cannot leave the organization' : 'Cannot remove the last owner',
        );
      }
      // Env steps run AS the connection owner: leaving with one intact would run the org on an ex-member's grant.
      const strandCount = await this.countMemberOrgConnections(em, orgId, targetUserId);
      if (strandCount > 0) {
        throw new DomainError(
          isSelf
            ? `You own ${strandCount} connection(s) that this organization's environments rely on — reconnect them as another owner/admin, reassign the slot, or remove them, before leaving.`
            : `This member owns ${strandCount} connection(s) that the organization's environments rely on — reconnect them as another owner/admin, reassign the slot, or remove them, before removing the member.`,
          409,
        );
      }
      await em.delete(OrgMemberEntity, { id: target.id });
      await this.events.emit(em, {
        orgId,
        actorUserId: actorId,
        type: isSelf ? 'org.member_left' : 'org.member_removed',
        subjectType: 'org_member',
        subjectId: targetUserId,
        payload: { user_id: targetUserId, role: target.role },
      });
    });
  }

  /** Pending = not yet accepted and not expired. */
  async listInvites(orgId: string): Promise<Array<Record<string, unknown>>> {
    const invites = await this.dataSource
      .createQueryBuilder(OrgInviteEntity, 'i')
      .where('i.org_id = :orgId', { orgId })
      .andWhere('i.accepted_at IS NULL')
      .andWhere('i.expires_at > now()')
      .orderBy('i.created_at', 'ASC')
      .getMany();
    return invites.map((i) => ({
      id: i.id,
      // The token IS the delivery mechanism in OSS (no mailer) — the link must stay re-copyable.
      token: i.token,
      email: i.email,
      role: i.role,
      created_at: i.createdAt?.toISOString() ?? null,
      expires_at: i.expiresAt.toISOString(),
    }));
  }

  async createInvite(
    org: OrganizationEntity,
    actorId: string,
    emailRaw: string,
    role: AssignableOrgRole,
  ): Promise<OrgInviteEntity> {
    const email = emailRaw.trim().toLowerCase();
    return this.dataSource.transaction(async (em) => {
      const pending = await em
        .createQueryBuilder(OrgInviteEntity, 'i')
        .where('i.org_id = :orgId', { orgId: org.id })
        .andWhere('LOWER(i.email) = :email', { email })
        .andWhere('i.accepted_at IS NULL')
        .andWhere('i.expires_at > now()')
        .getOne();
      if (pending) throw new DomainError('An invite for this email is already pending', 409);

      const invite = em.create(OrgInviteEntity, {
        id: newId(),
        orgId: org.id,
        email,
        role,
        // 48 hex chars of CSPRNG output — the token IS the credential.
        token: randomBytes(24).toString('hex'),
        createdBy: actorId,
        createdAt: now(),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
        acceptedBy: null,
        acceptedAt: null,
      });
      await em.insert(OrgInviteEntity, invite);
      await this.events.emit(em, {
        orgId: org.id,
        actorUserId: actorId,
        type: 'org.member_invited',
        subjectType: 'org_invite',
        subjectId: invite.id,
        payload: { email, role },
      });
      return invite;
    });
  }

  async revokeInvite(orgId: string, actorId: string, inviteId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const invite = isIdShape(inviteId)
        ? await em.findOne(OrgInviteEntity, { where: { id: inviteId, orgId } })
        : null;
      if (!invite || invite.acceptedAt) throw new DomainError('Invite not found', 404);
      await em.delete(OrgInviteEntity, { id: invite.id });
      await this.events.emit(em, {
        orgId,
        actorUserId: actorId,
        type: 'org.invite_revoked',
        subjectType: 'org_invite',
        subjectId: invite.id,
        payload: { email: invite.email, role: invite.role },
      });
    });
  }

  /** Peek an invite's org + role WITHOUT consuming it; same indistinguishable 404s as accept. */
  async previewInvite(token: string): Promise<{ org_id: string; org_name: string; role: OrgRole }> {
    const invite = await this.dataSource.manager.findOne(OrgInviteEntity, { where: { token } });
    const org = invite
      ? await this.dataSource.manager.findOne(OrganizationEntity, { where: { id: invite.orgId } })
      : null;
    if (!invite || !org || invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) {
      throw new DomainError('Invite not found or expired', 404);
    }
    // No invitee email: the token is link-bound, so the holder must not learn who it was addressed to.
    return { org_id: org.id, org_name: org.name, role: invite.role };
  }

  /** Token-bound accept: the link's holder joins with the invited role; already-a-member is a no-op. */
  async acceptInvite(userId: string, token: string): Promise<{ org_id: string; name: string }> {
    try {
      return await this.dataSource.transaction(async (em) => {
        const invite = await em.findOne(OrgInviteEntity, { where: { token } });
        const org = invite ? await em.findOne(OrganizationEntity, { where: { id: invite.orgId } }) : null;
        if (!invite || !org) throw new DomainError('Invite not found or expired', 404);

        const existing = await em.findOne(OrgMemberEntity, { where: { orgId: org.id, userId } });
        if (existing) return { org_id: org.id, name: org.name };

        if (invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) {
          throw new DomainError('Invite not found or expired', 404);
        }

        await em.insert(OrgMemberEntity, {
          id: newId(),
          orgId: org.id,
          userId,
          role: invite.role,
          createdAt: now(),
        });
        await em.update(OrgInviteEntity, { id: invite.id }, { acceptedBy: userId, acceptedAt: now() });
        await this.events.emit(em, {
          orgId: org.id,
          actorUserId: userId,
          type: 'org.member_joined',
          subjectType: 'org_member',
          subjectId: userId,
          payload: { role: invite.role, invite_id: invite.id },
        });
        return { org_id: org.id, name: org.name };
      });
    } catch (err) {
      // Double-submit race: the membership unique constraint makes the loser idempotent.
      if (this.isUniqueViolation(err)) {
        const invite = await this.dataSource.manager.findOne(OrgInviteEntity, { where: { token } });
        const org = invite
          ? await this.dataSource.manager.findOne(OrganizationEntity, { where: { id: invite.orgId } })
          : null;
        if (org) return { org_id: org.id, name: org.name };
      }
      throw err;
    }
  }

  async orgById(orgId: string): Promise<OrganizationEntity> {
    const org = isIdShape(orgId)
      ? await this.dataSource.manager.findOne(OrganizationEntity, { where: { id: orgId } })
      : null;
    if (!org) throw new DomainError('Organization not found', 404);
    return org;
  }

  async membershipOf(orgId: string, userId: string): Promise<OrgMemberEntity | null> {
    return this.dataSource.manager.findOne(OrgMemberEntity, { where: { orgId, userId } });
  }

  private async memberForUpdate(
    em: EntityManager,
    orgId: string,
    targetUserId: string,
  ): Promise<OrgMemberEntity> {
    const target = isIdShape(targetUserId)
      ? await em
          .createQueryBuilder(OrgMemberEntity, 'm')
          .setLock('pessimistic_write')
          .where('m.org_id = :orgId AND m.user_id = :targetUserId', { orgId, targetUserId })
          .getOne()
      : null;
    if (!target) throw new DomainError('Member not found', 404);
    return target;
  }

  private async ownerCount(em: EntityManager, orgId: string): Promise<number> {
    return em.count(OrgMemberEntity, { where: { orgId, role: 'owner' } });
  }

  /** Connections that would strand the org's envs if this member left: active cluster rows + env slots. */
  private async countMemberOrgConnections(em: EntityManager, orgId: string, userId: string): Promise<number> {
    const rows = await rawQuery<{ count: number }>(
      em,
      `SELECT COUNT(DISTINCT c.id)::int AS count
         FROM connections c
        WHERE c.user_id = $2
          AND (
            (c.org_id = $1 AND c.status = 'active')
            OR EXISTS (
              SELECT 1
                FROM environment_connections ec
                JOIN environments e ON e.id = ec.environment_id
               WHERE ec.connection_id = c.id AND e.org_id = $1
            )
          )`,
      [orgId, userId],
    );
    return rows[0]?.count ?? 0;
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = (err as { driverError?: { code?: string }; code?: string }) ?? {};
    return e.driverError?.code === PG_UNIQUE_VIOLATION || e.code === PG_UNIQUE_VIOLATION;
  }
}
