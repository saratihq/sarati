import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A named environment; "Default" is the raw pool and has NO row. Names are stored
 * lowercase and unique case-insensitively per org; the `is_prod` row is non-renamable/non-deletable.
 */
@Entity('environments')
export class EnvironmentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'is_prod', type: 'boolean', default: false })
  isProd!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * A SLOT: (environment, app) → one pool connection, by REFERENCE — assigning never mutates the
 * connection row, and a missing slot fails honestly rather than falling back to the pool.
 */
@Entity('environment_connections')
export class EnvironmentConnectionEntity {
  @PrimaryColumn({ name: 'environment_id', type: 'uuid' })
  environmentId!: string;

  /** App slug (`slack`, `gmail`, …) — the provider key the resolver matches. */
  @PrimaryColumn({ type: 'text' })
  app!: string;

  @Column({ name: 'connection_id', type: 'uuid' })
  connectionId!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
