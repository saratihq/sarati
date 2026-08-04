import { Column, Entity, OneToOne, PrimaryColumn } from 'typeorm';

import { UserSettingsEntity } from './user-settings.entity';

/** Hand-mapped to the live `users` table; ids and timestamps are app-supplied (no DB defaults). */
@Entity('users')
export class UserEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  /** Null only on legacy password-era rows not yet adopted by Clerk sign-in. */
  @Column({ name: 'clerk_user_id', type: 'varchar', length: 64, unique: true, nullable: true })
  clerkUserId!: string | null;

  /** Legacy — retained for pre-Clerk rows; no code path writes it anymore. */
  @Column({ name: 'hashed_password', type: 'varchar', length: 255, nullable: true })
  hashedPassword!: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @OneToOne(() => UserSettingsEntity, (s) => s.user)
  settings?: UserSettingsEntity | null;
}
