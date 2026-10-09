import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { RuntimeTriggerActivationEntity } from '../database/entities/runtime-trigger-activation.entity';

/** Refuse a delete whose cascade would drop an activation not yet torn down, stranding it at its app (constitution row 11). */
export async function assertTriggersReleased(
  em: EntityManager,
  where: { workflowId: string } | { environmentId: string },
  subject: string,
): Promise<void> {
  const held = await em.find(RuntimeTriggerActivationEntity, { where });
  if (held.length === 0) return;
  const one = held.length === 1;
  const error = held.find((a) => a.lastError)?.lastError;
  throw new DomainError(
    `${subject} is no longer live, but ${one ? 'one of its triggers' : `${held.length} of its triggers`} ` +
      `couldn't be removed from ${one ? 'its app' : 'their apps'} yet, so ${subject} was kept — delete it ` +
      `again to retry.${error ? ` ${error}` : ''}`,
    409,
  );
}
