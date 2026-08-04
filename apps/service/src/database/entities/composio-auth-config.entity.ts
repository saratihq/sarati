import { Column, Entity, PrimaryColumn } from 'typeorm';

/** One Composio auth config per toolkit, persisted so restarts never mint duplicate OAuth apps. */
@Entity('composio_auth_configs')
export class ComposioAuthConfigEntity {
  @PrimaryColumn({ name: 'toolkit_slug', type: 'varchar', length: 120 })
  toolkitSlug!: string;

  @Column({ name: 'auth_config_id', type: 'varchar', length: 120 })
  authConfigId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
