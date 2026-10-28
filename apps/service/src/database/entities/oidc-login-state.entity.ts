import { Column, Entity, PrimaryColumn } from 'typeorm';

/** What a sign-in flow is for: entering an account, or connecting an identity to the signed-in one. */
export type OidcFlowPurpose = 'sign_in' | 'link';

/** One browser sign-in between its start and its completion; single-use, and keyed by a hash so a database read cannot finish it. */
@Entity('oidc_login_states')
export class OidcLoginStateEntity {
  /** sha256(state), hex. */
  @PrimaryColumn({ name: 'state_hash', type: 'varchar', length: 64 })
  stateHash!: string;

  @Column({ type: 'varchar', length: 64 })
  nonce!: string;

  @Column({ name: 'code_verifier', type: 'varchar', length: 128 })
  codeVerifier!: string;

  /** base64url(sha256(binding)) — the tab that started the flow holds the binding itself. */
  @Column({ name: 'binding_hash', type: 'varchar', length: 64 })
  bindingHash!: string;

  @Column({ type: 'varchar', length: 16 })
  purpose!: OidcFlowPurpose;

  /** The account a `link` flow connects to; null for `sign_in`. */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  /** An org invite the signer-in carried from its link. */
  @Column({ name: 'invite_token', type: 'varchar', length: 80, nullable: true })
  inviteToken!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
