import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A binary blob from a run step, referenced in the run scope as a `FileHandle` — the bytes live
 * here in `bytea` and NEVER in the run's json scope. `run_id` is the scoped run id.
 */
@Entity('runtime_blobs')
@Index('ix_runtime_blobs_run', ['runId'])
export class RuntimeBlobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** The scoped run id this blob belongs to (for run-scoped cleanup). */
  @Column({ name: 'run_id', type: 'varchar', length: 200 })
  runId!: string;

  @Column({ type: 'varchar', length: 500 })
  filename!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 255 })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  @Column({ type: 'bytea' })
  data!: Buffer;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
