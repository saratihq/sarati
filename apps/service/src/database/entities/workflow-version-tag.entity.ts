import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-(workflow, branch) `latest` bookkeeping; uniqueness lives in DB-owned partial indexes —
 * `latest` is unique per (workflow, branch), every other tag per workflow.
 */
@Entity('workflow_version_tags')
export class WorkflowVersionTagEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ type: 'varchar', length: 100 })
  tag!: string;

  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId!: string | null;

  @Column({ type: 'boolean', default: true })
  activated!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
