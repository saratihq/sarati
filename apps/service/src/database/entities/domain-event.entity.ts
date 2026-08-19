import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The append-only outbox: written in the SAME transaction as the mutation it describes,
 * and never updated or deleted by code.
 */
@Entity('domain_events')
export class DomainEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  /** 'user' | 'system' | 'api_key' */
  @Column({ name: 'actor_type', type: 'varchar', length: 20, default: 'user' })
  actorType!: string;

  /** Dotted event name, e.g. 'user.provisioned', 'workflow.deployed'. */
  @Column({ type: 'varchar', length: 100 })
  type!: string;

  @Column({ name: 'subject_type', type: 'varchar', length: 50, nullable: true })
  subjectType!: string | null;

  @Column({ name: 'subject_id', type: 'varchar', length: 64, nullable: true })
  subjectId!: string | null;

  @Column({ type: 'json', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
