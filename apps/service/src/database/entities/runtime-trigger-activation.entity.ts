import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

/**
 * A materialized trigger ACTIVATION (ADR 0018) — DERIVED STATE the reconciler converges. Only an
 * env-pointer move or slot change alters one; a commit never does (Save ≠ Live, invariant #2).
 */
@Entity('runtime_trigger_activations')
@Unique('uq_activation_wf_env_node', ['workflowId', 'environmentId', 'triggerNodeId'])
@Index('ix_activation_workflow', ['workflowId'])
@Index('ix_activation_kind', ['kind'])
@Index('ix_activation_composio_instance', ['composioTriggerInstanceId'])
export class RuntimeTriggerActivationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  /** The promoted env whose pointer put this node live. FK → environments (cascade). */
  @Column({ name: 'environment_id', type: 'uuid' })
  environmentId!: string;

  /** The IR node id of the trigger node — `sha256(name)[:12]`; name IS identity (vault). */
  @Column({ name: 'trigger_node_id', type: 'varchar', length: 64 })
  triggerNodeId!: string;

  /** Activation kind: `webhook` | `registered_webhook` | `polling` | `schedule`. */
  @Column({ type: 'varchar', length: 40 })
  kind!: string;

  /** The trigger node's `node_type` (public trigger type) — what the provider seam is handed. */
  @Column({ name: 'trigger_type', type: 'varchar', length: 300 })
  triggerType!: string;

  /** The last version this activation was reconciled to (observability + cursor-handoff diff). */
  @Column({ name: 'version_id', type: 'uuid', nullable: true })
  versionId!: string | null;

  /** The trigger node's `parameters` snapshot — the descriptor the reconciler compares (deepEqual). */
  @Column({ type: 'json', nullable: true })
  props!: Record<string, unknown> | null;

  /** Composio trigger-instance id (ADR 0046); NOT unique — Composio dedupes instances, so
   *  activations sharing a slot + config share an id (delivery fans out, delete refcounts). */
  @Column({ name: 'composio_trigger_instance_id', type: 'varchar', length: 64, nullable: true })
  composioTriggerInstanceId!: string | null;

  /** The env slot connection resolved at reconcile time (`null` for native kinds); run-as owner below. */
  @Column({ name: 'connection_id', type: 'uuid', nullable: true })
  connectionId!: string | null;

  @Column({ name: 'connection_owner_user_id', type: 'uuid', nullable: true })
  connectionOwnerUserId!: string | null;

  /** Operator override: a paused activation is desired-present but does not fire. */
  @Column({ type: 'boolean', default: false })
  paused!: boolean;

  @Column({ name: 'last_polled_at', type: 'timestamptz', nullable: true })
  lastPolledAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/** Per-activation persistent KV (cursors, webhook secret/handle); rows cascade with the activation. */
@Entity('runtime_activation_store')
export class RuntimeActivationStoreEntity {
  @PrimaryColumn({ name: 'activation_id', type: 'uuid' })
  activationId!: string;

  @PrimaryColumn({ type: 'varchar', length: 300 })
  key!: string;

  @Column({ type: 'json', nullable: true })
  value!: unknown;
}
