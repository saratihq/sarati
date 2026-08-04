import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * An env-scoped webhook signing secret, encrypted and stored OUT of the version doc — secrets are
 * env config and must never be diffed or shown in a review.
 */
@Entity('webhook_trigger_secrets')
export class WebhookTriggerSecretEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  @Column({ name: 'environment_id', type: 'uuid', nullable: true })
  environmentId!: string | null;

  @Column({ name: 'node_id', type: 'text' })
  nodeId!: string;

  /** Fernet-encrypted signing secret. */
  @Column({ type: 'text' })
  secret!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
