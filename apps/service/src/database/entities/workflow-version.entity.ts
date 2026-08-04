import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Version numbers are PER-BRANCH (UNIQUE(workflow_id, branch_id, version_number)) and the next one
 * must be computed under a branch-row FOR UPDATE lock.
 */
@Entity('workflow_versions')
export class WorkflowVersionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId!: string;

  @Column({ name: 'version_number', type: 'int' })
  versionNumber!: number;

  @Column({ name: 'workflow_json', type: 'json' })
  workflowJson!: Record<string, unknown>;

  @Column({ name: 'workflow_ir', type: 'json', nullable: true })
  workflowIr!: Record<string, unknown> | null;

  /** Legacy text diff — effectively dead; carried for API shape. */
  @Column({ type: 'text', nullable: true })
  diff!: string | null;

  @Column({ name: 'ir_diff', type: 'json', nullable: true })
  irDiff!: Record<string, unknown> | null;

  @Column({ name: 'commit_message', type: 'varchar', length: 500, nullable: true })
  commitMessage!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  /** Free string (user name / automation actor / user-id) — superseded by actor propagation. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  author!: string | null;

  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId!: string | null;

  /** Previous version on the same branch. */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  /** Source-branch head — set only on merge commits. */
  @Column({ name: 'merge_parent_id', type: 'uuid', nullable: true })
  mergeParentId!: string | null;
}
