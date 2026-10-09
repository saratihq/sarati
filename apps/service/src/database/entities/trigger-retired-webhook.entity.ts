import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { RegisteredWebhook } from '../../triggers/registered-webhook';

/** An app webhook whose delete failed, retried by later reconciles until it succeeds or can never succeed. */
@Entity('trigger_retired_webhooks')
@Index('ix_trigger_retired_webhooks_workflow', ['workflowId'])
export class TriggerRetiredWebhookEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** The workflow it was registered for — no foreign key, so the delete outlives the workflow. */
  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  /** The environment it was registered in — no foreign key, so the delete outlives the environment. */
  @Column({ name: 'environment_id', type: 'uuid' })
  environmentId!: string;

  /** The trigger node that registered it. */
  @Column({ name: 'trigger_node_id', type: 'varchar', length: 64 })
  triggerNodeId!: string;

  /** Everything its delete needs, as it was registered. */
  @Column({ type: 'jsonb' })
  webhook!: RegisteredWebhook;

  /** Why the last delete failed, as thrown — for the operator; never shown on a trigger. */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
