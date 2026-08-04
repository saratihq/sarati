import { Column, Entity, PrimaryColumn } from 'typeorm';

/** The tenancy boundary. */
@Entity('organizations')
export class OrganizationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** Auto-created 1:1 org for each user; the coexistence shim (ADR 0037). */
  @Column({ name: 'is_personal', type: 'boolean', default: false })
  isPersonal!: boolean;

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

/** Fixed OSS role matrix (ADR 0037); custom roles are an ee extension point. */
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

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
