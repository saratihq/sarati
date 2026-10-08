import { Column, Entity, PrimaryColumn } from 'typeorm';

/** One Composio auth config per toolkit per Composio project, persisted so restarts never mint duplicate OAuth apps. */
@Entity('composio_auth_configs')
export class ComposioAuthConfigEntity {
  /** The project the config lives in: a SHA-256 of the API key that found it, never the key. */
  @PrimaryColumn({ name: 'project_key', type: 'varchar', length: 64 })
  projectKey!: string;

  @PrimaryColumn({ name: 'toolkit_slug', type: 'varchar', length: 120 })
  toolkitSlug!: string;

  @Column({ name: 'auth_config_id', type: 'varchar', length: 120 })
  authConfigId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
