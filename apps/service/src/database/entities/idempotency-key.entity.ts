import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Replays the first response for a retried mutating request. */
@Entity('idempotency_keys')
export class IdempotencyKeyEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 10 })
  method!: string;

  @Column({ type: 'varchar', length: 500 })
  path!: string;

  @Column({ name: 'status_code', type: 'int', nullable: true })
  statusCode!: number | null;

  @Column({ name: 'response_body', type: 'json', nullable: true })
  responseBody!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  completed!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
