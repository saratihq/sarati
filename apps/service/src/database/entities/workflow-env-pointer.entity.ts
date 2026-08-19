import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-environment live pointer: only a pointer move changes what runs (Save ≠ Live).
 * `workflows.active_version_id` is the legacy alias of the `prod` row and MUST be synced with it.
 */
@Entity('workflow_env_pointers')
export class WorkflowEnvPointerEntity {
  @PrimaryColumn({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  environment!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** The environments row — dual-written with the legacy name; reads prefer the id. */
  @Column({ name: 'environment_id', type: 'uuid', nullable: true })
  environmentId!: string | null;
}
