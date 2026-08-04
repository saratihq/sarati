import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainEventEntity } from '../database/entities/domain-event.entity';
import { newId, now } from '../database/ids';

export interface DomainEventInput {
  orgId?: string | null;
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'api_key';
  type: string;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * The outbox (ADR 0037) behind audit, notifications, and metering. `emit` writes within the
 * CALLER's transaction, so an event exists iff the mutation committed.
 */
@Injectable()
export class EventsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async emit(em: EntityManager, event: DomainEventInput): Promise<void> {
    const row = em.create(DomainEventEntity, {
      id: newId(),
      orgId: event.orgId ?? null,
      actorUserId: event.actorUserId ?? null,
      actorType: event.actorType ?? 'user',
      type: event.type,
      subjectType: event.subjectType ?? null,
      subjectId: event.subjectId ?? null,
      payload: event.payload ?? null,
      createdAt: now(),
    });
    await em.save(DomainEventEntity, row);
  }

  /** For emitters with no surrounding transaction (system/background events). */
  async emitDetached(event: DomainEventInput): Promise<void> {
    await this.emit(this.dataSource.manager, { actorType: 'system', ...event });
  }
}
