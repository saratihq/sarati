import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';

import { UserEntity } from './user.entity';

/** 1:1 with user, no modeled fields today; the table's inert legacy columns are left unmapped. */
@Entity('user_settings')
export class UserSettingsEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId!: string;

  @OneToOne(() => UserEntity, (u) => u.settings)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;
}
