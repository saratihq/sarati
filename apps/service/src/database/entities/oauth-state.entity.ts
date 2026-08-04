import { Column, Entity, PrimaryColumn } from 'typeorm';

/** OAuth CSRF state (10-min expiry); `codeVerifier` keeps the PKCE secret server-side. */
@Entity('oauth_states')
export class OAuthStateEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  state!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  provider!: string | null;

  @Column({ name: 'code_verifier', type: 'varchar', length: 255, nullable: true })
  codeVerifier!: string | null;

  /** BYO OAuth client carried authorize → callback (ADR 0042), encrypted; null for env-configured. */
  @Column({ name: 'oauth_client', type: 'text', nullable: true })
  oauthClient!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
