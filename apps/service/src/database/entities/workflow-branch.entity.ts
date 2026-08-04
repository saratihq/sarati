import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A new branch's `head_version_id` points at the FORK version — a row on the SOURCE branch — until
 * its first commit; display logic depends on those fork-point semantics.
 */
@Entity('workflow_branches')
export class WorkflowBranchEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'head_version_id', type: 'uuid', nullable: true })
  headVersionId!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  /** Opt-in branch protection: enforced when set; user-settable. */
  @Column({ name: 'is_protected', type: 'boolean', default: false })
  isProtected!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
