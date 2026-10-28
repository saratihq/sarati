import { Column, Entity, PrimaryColumn } from 'typeorm';

/** The tenancy boundary. */
@Entity('organizations')
export class OrganizationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** Auto-created 1:1 org for each user; the coexistence shim. */
  @Column({ name: 'is_personal', type: 'boolean', default: false })
  isPersonal!: boolean;

  /** The account a personal org belongs to, its one member (constitution row 22); null for a shared org. */
  @Column({ name: 'personal_owner_id', type: 'uuid', nullable: true })
  personalOwnerId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;
}

export const ORG_ROLES = ['owner', 'admin', 'member', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** The roles the org API hands out (invites / role changes) — the client contract's vocabulary. */
export const ASSIGNABLE_ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type AssignableOrgRole = (typeof ASSIGNABLE_ORG_ROLES)[number];

/** Fixed OSS role matrix; custom roles are an ee extension point. */
@Entity('org_members')
export class OrgMemberEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 20 })
  role!: OrgRole;

  /** Its org's own `is_personal`, which the database holds it to, so a personal org takes one member, as owner (constitution row 22). */
  @Column({ name: 'is_personal', type: 'boolean', default: false })
  isPersonal!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
