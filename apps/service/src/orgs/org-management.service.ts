import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape, newId, now } from '../database/ids';
import { OrgInviteEntity } from '../database/entities/org-invite.entity';
import { UserEntity } from '../database/entities/user.entity';
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
import { isUniqueViolation } from '../database/pg-errors';
import { insertOrg } from './insert-org';
import { lockInvite, lockOrgForDelete, lockOrgForWrite } from './org-row-lock';
import { OrgsService } from './orgs.service';

const INVITE_TTL_DAYS = 14;

const noOtherMembers = (): DomainError => new DomainError('The personal organization has no other members');

declare const held: unique symbol;

/** An invite held under its locks, with its org and whether it can be redeemed, judged on the held row: only `claimInvite` makes one. */
export type ClaimedInvite = {
  readonly invite: OrgInviteEntity;
  readonly org: OrganizationEntity;
  readonly [held]: true;
} & ({ readonly redeemable: true } | { readonly redeemable: false });

/** A claimed invite judged redeemable: the only kind `redeemInvite` spends. */
export type RedeemableInvite = Extract<ClaimedInvite, { redeemable: true }>;

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
    private readonly orgs: OrgsService,
  ) {}

  /** The caller's memberships, their own personal org first and the only one marked personal (client contract). */
  async listOrgs(userId: string): Promise<OrgSummary[]> {
    const em = this.dataSource.manager;
    const personal = await this.orgs.personalOrgOf(em, userId);
    const rows = await rawQuery<{ id: string; name: string; role: OrgRole }>(
      em,
      `SELECT o.id, o.name, m.role
         FROM organizations o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.id = $2 DESC, o.created_at ASC`,
      [userId, personal?.id ?? null],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, is_personal: r.id === personal?.id, role: r.role }));
  }

  async createOrg(actorId: string, name: string): Promise<OrgSummary> {
    return this.dataSource.transaction(async (em) => {
      const org = await insertOrg(em, { name, isPersonal: false, ownerId: actorId });
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
      await lockOrgForWrite(em, org.id);
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

  /** Delete a non-personal org; refuses while workflows remain, deletes its cluster connections and revokes their Composio accounts, memberships/invites/keys cascade. */
  async deleteOrg(org: OrganizationEntity, actorId: string): Promise<void> {
    if (org.isPersonal) throw new DomainError('The personal organization cannot be deleted');
    const clusters = await this.dataSource.transaction(async (em) => {
      const connections = await lockOrgForDelete(em, org.id, () => this.refuseWhileWorkflows(em, org.id));
      const removal = await this.connections.deleteLocked(em, connections);
      await this.events.emit(em, {
        orgId: org.id,
        actorUserId: actorId,
        type: 'org.deleted',
        subjectType: 'organization',
        subjectId: org.id,
        payload: { name: org.name },
      });
      await em.delete(OrganizationEntity, { id: org.id });
      return removal;
    });
    await clusters.afterCommit();
  }

  private async refuseWhileWorkflows(em: EntityManager, orgId: string): Promise<void> {
    // They'd be orphaned via the SET-NULL FK.
    const workflows = await em.count(WorkflowEntity, { where: { orgId } });
    if (workflows > 0) {
      throw new DomainError(
        `This organization still has ${workflows} workflow${workflows === 1 ? '' : 's'} — move or delete them before deleting the organization.`,
        409,
      );
    }
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
    org: OrganizationEntity,
    actorId: string,
    targetUserId: string,
    role: AssignableOrgRole,
  ): Promise<Record<string, unknown>> {
    if (org.isPersonal) throw noOtherMembers();
    const orgId = org.id;
    return this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, orgId);
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

  /** Hands ownership over: target → owner, actor → admin in one transaction, so the org never has no owner. */
  async transferOwnership(
    org: OrganizationEntity,
    actorId: string,
    targetUserId: string,
  ): Promise<OrgSummary> {
    if (org.isPersonal) throw noOtherMembers();
    if (actorId === targetUserId) throw new DomainError('You are already the owner');
    return this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, org.id);
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
  async removeMember(org: OrganizationEntity, actorId: string, targetUserId: string): Promise<void> {
    if (org.isPersonal) throw noOtherMembers();
    const orgId = org.id;
    const isSelf = actorId === targetUserId;
    await this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, orgId);
      const target = await this.memberForUpdate(em, orgId, targetUserId);
      if (!isSelf && target.role === 'owner') {
        const actor = await em.findOne(OrgMemberEntity, { where: { orgId, userId: actorId } });
        if (actor?.role !== 'owner') throw new DomainError('Only an owner can remove an owner', 403);
      }
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

  /** Pending (unaccepted, unexpired) invites; an owner invite's link is shown only to an owner. */
  async listInvites(orgId: string, viewerRole: OrgRole): Promise<Array<Record<string, unknown>>> {
    const invites = await this.dataSource
      .createQueryBuilder(OrgInviteEntity, 'i')
      .where('i.org_id = :orgId', { orgId })
      .andWhere('i.accepted_at IS NULL')
      .andWhere('i.expires_at > now()')
      .orderBy('i.created_at', 'ASC')
      .getMany();
    return invites.map((i) => ({
      id: i.id,
      // The token IS the delivery mechanism in OSS (no mailer), so it stays re-copyable — except an owner's to an admin.
      token: i.role === 'owner' && viewerRole !== 'owner' ? null : i.token,
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
    if (org.isPersonal) throw noOtherMembers();
    const email = emailRaw.trim().toLowerCase();
    return this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, org.id);
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
        // 48 hex chars of CSPRNG output, so no link can be guessed.
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
      await lockOrgForWrite(em, orgId);
      const invite = isIdShape(inviteId) ? await lockInvite(em, { id: inviteId, orgId }) : null;
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

  /** Whether an invite can still be redeemed: unused, unexpired, into an org that is not personal (constitution row 22), and an owner invite only while its creator is an owner. */
  private async isRedeemable(
    em: EntityManager,
    invite: OrgInviteEntity,
    org: OrganizationEntity,
  ): Promise<boolean> {
    if (org.isPersonal || invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) return false;
    if (invite.role !== 'owner') return true;
    const creator = invite.createdBy
      ? await em.findOne(OrgMemberEntity, { where: { orgId: invite.orgId, userId: invite.createdBy } })
      : null;
    return creator?.role === 'owner';
  }

  /** Peek an invite's org + role WITHOUT consuming it; same indistinguishable 404s as accept. */
  async previewInvite(token: string): Promise<{ org_id: string; org_name: string; role: OrgRole }> {
    const em = this.dataSource.manager;
    const invite = await em.findOne(OrgInviteEntity, { where: { token } });
    const org = invite ? await em.findOne(OrganizationEntity, { where: { id: invite.orgId } }) : null;
    if (!invite || !org || !(await this.isRedeemable(em, invite, org))) {
      throw new DomainError('Invite not found or expired', 404);
    }
    // No invitee email: whoever holds the link must not learn who it was addressed to.
    return { org_id: org.id, org_name: org.name, role: invite.role };
  }

  /** The account the invite was sent to joins with the invited role; already-a-member is a no-op. */
  async acceptInvite(userId: string, token: string): Promise<{ org_id: string; name: string }> {
    const joined = await this.joinByInvite(userId, token);
    if (!joined) throw new DomainError('Invite not found or expired', 404);
    return joined;
  }

  /** {@link acceptInvite} in a transaction of its own, answering null for a token that can no longer be redeemed. */
  async joinByInvite(userId: string, token: string): Promise<{ org_id: string; name: string } | null> {
    try {
      return await this.dataSource.transaction(async (em) => {
        return this.acceptInviteWith(em, userId, token);
      });
    } catch (err) {
      // Double-submit race: the membership unique constraint makes the loser idempotent.
      if (isUniqueViolation(err)) {
        const invite = await this.dataSource.manager.findOne(OrgInviteEntity, { where: { token } });
        const org = invite
          ? await this.dataSource.manager.findOne(OrganizationEntity, { where: { id: invite.orgId } })
          : null;
        if (org) return { org_id: org.id, name: org.name };
      }
      throw err;
    }
  }

  /** {@link acceptInvite} inside the caller's transaction, so joining commits with what the caller writes beside it; null for a token that can no longer be redeemed. */
  async acceptInviteWith(
    em: EntityManager,
    userId: string,
    token: string,
  ): Promise<{ org_id: string; name: string } | null> {
    const spent = new DomainError('Invite not found or expired', 404);
    let claimed: ClaimedInvite;
    try {
      claimed = await this.claimInvite(em, token, spent);
    } catch (err) {
      if (err === spent) return null;
      throw err;
    }
    const { invite, org } = claimed;

    const existing = await em.findOne(OrgMemberEntity, { where: { orgId: org.id, userId } });
    if (existing) return { org_id: org.id, name: org.name };

    if (!claimed.redeemable) return null;
    await this.assertInvitee(em, userId, invite);
    return this.redeemInvite(em, userId, claimed);
  }

  /** Holds the invite `token` names for an accept or a registration against it: its org row FOR KEY SHARE, then the invite FOR UPDATE (constitution row 20); throws `refused` once either is gone. */
  async claimInvite(em: EntityManager, token: string, refused: DomainError): Promise<ClaimedInvite> {
    const sought = await em.findOne(OrgInviteEntity, { where: { token } });
    if (!sought) throw refused;
    await lockOrgForWrite(em, sought.orgId, refused);
    const invite = await lockInvite(em, { id: sought.id });
    if (!invite) throw refused;
    const org = await em.findOneByOrFail(OrganizationEntity, { id: invite.orgId });
    return { invite, org, redeemable: await this.isRedeemable(em, invite, org) } as ClaimedInvite;
  }

  /** Spends a claimed, redeemable invite on `userId`, who joins its org with its role: the one write every accept of an invite makes. */
  async redeemInvite(
    em: EntityManager,
    userId: string,
    { invite, org }: RedeemableInvite,
  ): Promise<{ org_id: string; name: string }> {
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
  }

  /** An invite admits only the account at the address it was sent to, and only while the account can vouch for that address. */
  private async assertInvitee(em: EntityManager, userId: string, invite: OrgInviteEntity): Promise<void> {
    const user = await em.findOneByOrFail(UserEntity, { id: userId });
    if (user.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
      throw new DomainError(
        `This invite was sent to a different email address than ${user.email}. Ask whoever invited you to invite that address, or sign in with the account the invite was sent to.`,
        403,
        { code: 'invite_email_mismatch' },
      );
    }
    if (!user.emailVerified) {
      throw new DomainError(
        `Your identity provider did not confirm ${user.email} (the email_verified claim), so this invite cannot be matched to you.`,
        403,
        { code: 'invite_email_unverified' },
      );
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
}
