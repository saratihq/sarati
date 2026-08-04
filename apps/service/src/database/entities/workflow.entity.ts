import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Live `workflows`: the native build-and-run workflow. */
@Entity('workflows')
export class WorkflowEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Workflow origin — an app-enforced string, not a DB enum. */
  @Column({ type: 'varchar', length: 20, default: 'generated' })
  source!: string;

  @Column({ name: 'active_version_id', type: 'uuid', nullable: true })
  activeVersionId!: string | null;

  @Column({ name: 'default_branch_id', type: 'uuid', nullable: true })
  defaultBranchId!: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  /** Tenancy owner; nullable during coexistence, backfilled to the personal org. */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;
}
