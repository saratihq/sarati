import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { OrgRole } from './organization.entity';

/** Pending org membership offers. The token IS the credential — accept binds by token, not email. */
@Entity('org_invites')
export class OrgInviteEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 20, default: 'member' })
  role!: OrgRole;

  @Column({ type: 'varchar', length: 80, unique: true })
  token!: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Set on accept — a consumed invite can never admit a second account. */
  @Column({ name: 'accepted_by', type: 'uuid', nullable: true })
  acceptedBy!: string | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;
}
