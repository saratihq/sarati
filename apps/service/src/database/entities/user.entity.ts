import { Column, Entity, OneToOne, PrimaryColumn } from 'typeorm';

import { UserSettingsEntity } from './user-settings.entity';

/** Hand-mapped to the live `users` table; ids and timestamps are app-supplied (no DB defaults). */
@Entity('users')
export class UserEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** One account holds an address confirmed, in any letter case (`ix_users_confirmed_email`); unconfirmed ones may share it. */
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  /** The Clerk user id — an OIDC `sub` on accounts the retired bearer sign-in created; null otherwise. */
  @Column({ name: 'clerk_user_id', type: 'varchar', length: 64, unique: true, nullable: true })
  clerkUserId!: string | null;

  /** scrypt hash of the account's password; null when it has none. */
  @Column({ name: 'hashed_password', type: 'varchar', length: 255, nullable: true })
  hashedPassword!: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** Whether the account holds its email: false when single sign-on made it from an address its provider did not confirm, or it gave the address up; no invite is matched to an address it does not hold. */
  @Column({ name: 'email_verified', type: 'boolean', default: true })
  emailVerified!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @OneToOne(() => UserSettingsEntity, (s) => s.user)
  settings?: UserSettingsEntity | null;
}
