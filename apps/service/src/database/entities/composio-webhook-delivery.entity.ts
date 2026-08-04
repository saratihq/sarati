import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The inbound idempotency ledger for at-least-once Composio deliveries: the intake claims the id
 * BEFORE firing, and a conflict must be acked without re-running the workflow.
 */
@Entity('composio_webhook_deliveries')
export class ComposioWebhookDeliveryEntity {
  /** The Svix `webhook-id` header — stable per message, the idempotency key. */
  @PrimaryColumn({ name: 'webhook_id', type: 'text' })
  webhookId!: string;

  /** The `ti_…` instance the delivery named, for forensics. Nullable by design. */
  @Column({ name: 'trigger_id', type: 'text', nullable: true })
  triggerId!: string | null;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}
