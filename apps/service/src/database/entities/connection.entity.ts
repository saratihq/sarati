import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * An account connected for a `provider`. `credential` is
 * Fernet-encrypted JSON; `authType` is `token`, `oauth2`, or `managed` (Composio, no secret here).
 */
@Entity('connections')
export class ConnectionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 120 })
  provider!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 200, nullable: true })
  displayName!: string | null;

  @Column({ name: 'auth_type', type: 'varchar', length: 30 })
  authType!: string;

  @Column({ type: 'text' })
  credential!: string;

  /** BYO OAuth client that minted this connection (ADR 0042), encrypted — REFRESH must redeem
   *  against the same client. Null for env-configured providers and non-oauth2 rows. */
  @Column({ name: 'oauth_client', type: 'text', nullable: true })
  oauthClient!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  /** Lifecycle + health: `pending` → `active`/`failed`, later flipping to `expired`/`failed` and back. */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  /** Plain-language reason when status is not `active`/`pending`; null otherwise. */
  @Column({ name: 'status_reason', type: 'text', nullable: true })
  statusReason!: string | null;

  /** When health was last verified: test probe, status-poll flip, or run-time renewal. */
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  /** Connection scoping: `(null, null)` is PERSONAL; `(org, environment)` is a curated env slot. */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  environment!: string | null;
}
