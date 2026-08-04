import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Only the key HASH is stored — the plaintext exists once, in the creation response. */
@Entity('api_keys')
export class ApiKeyEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ name: 'key_hash', type: 'varchar', length: 128 })
  keyHash!: string;

  /** First chars of the key for identification in UIs (never enough to use). */
  @Column({ type: 'varchar', length: 12 })
  prefix!: string;

  @Column({ type: 'json', nullable: true })
  scopes!: string[] | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
