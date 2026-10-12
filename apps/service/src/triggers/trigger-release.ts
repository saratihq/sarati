import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { RuntimeTriggerActivationEntity } from '../database/entities/runtime-trigger-activation.entity';
import { rawQuery } from '../database/raw-query';

/** A workflow or an environment about to be deleted. */
export type DeletedParent = { workflowId: string } | { environmentId: string };

/** Lock what is being deleted and refuse while a pointer or an activation is back on it, so its cascade never drops a live trigger (constitution row 11). */
export async function lockDeletable(
  em: EntityManager,
  parent: DeletedParent,
  subject: string,
): Promise<void> {
  const [lockRow, pointerOn, id] =
    'workflowId' in parent
      ? [
          `SELECT 1 FROM workflows WHERE id = $1 FOR UPDATE`,
          `SELECT 1 FROM workflow_env_pointers WHERE workflow_id = $1 LIMIT 1`,
          parent.workflowId,
        ]
      : [
          `SELECT 1 FROM environments WHERE id = $1 FOR UPDATE`,
          `SELECT 1 FROM workflow_env_pointers WHERE environment_id = $1 LIMIT 1`,
          parent.environmentId,
        ];
  if ((await rawQuery(em, lockRow, [id])).length === 0) {
    throw new DomainError(`${subject} was already deleted`, 404);
  }
  if ((await rawQuery(em, pointerOn, [id])).length > 0) {
    throw new DomainError(
      `${subject} was promoted again while it was being deleted, so it was kept — delete it again`,
      409,
    );
  }
  if ((await em.count(RuntimeTriggerActivationEntity, { where: parent })) > 0) {
    throw new DomainError(
      `${subject} is no longer live, but its triggers are still being removed from their apps, so it was kept — delete it again in a moment`,
      409,
    );
  }
}
