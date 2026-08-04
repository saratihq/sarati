import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Live `node_icons` — PK is the node type string (icon cache for the canvas). */
@Entity('node_icons')
export class NodeIconEntity {
  @PrimaryColumn({ name: 'node_type', type: 'varchar', length: 255 })
  nodeType!: string;

  @Column({ type: 'text' })
  svg!: string;

  @Column({ type: 'varchar', length: 50 })
  source!: string;

  @Column({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;
}
