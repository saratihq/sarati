import { Column, Entity, PrimaryColumn } from 'typeorm';

/** A sign-in identity at an OpenID Connect provider; `(issuer, subject)` names exactly one user. */
@Entity('user_identities')
export class UserIdentityEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** The provider's `iss`, verbatim. */
  @Column({ type: 'varchar', length: 512 })
  issuer!: string;

  /** The provider's `sub` for this person. */
  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  /** The email the provider reported when the identity was linked — display and audit only, never a lookup key. */
  @Column({ name: 'email_at_link', type: 'varchar', length: 255, nullable: true })
  emailAtLink!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;
}
