import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { rawQuery } from '../database/raw-query';

async function lockRow(
  em: EntityManager,
  workflowId: string,
  mode: 'FOR KEY SHARE' | 'FOR NO KEY UPDATE',
): Promise<boolean> {
  const rows = await rawQuery(em, `SELECT 1 FROM workflows WHERE id = $1 ${mode}`, [workflowId]);
  return rows.length > 0;
}

/** Lock the workflow row FOR KEY SHARE, the first lock of any write under it, so it queues behind a delete instead of deadlocking with its cascade; false when it is gone. */
export function lockWorkflowRow(em: EntityManager, workflowId: string): Promise<boolean> {
  return lockRow(em, workflowId, 'FOR KEY SHARE');
}

/** {@link lockWorkflowRow}, answering 404 when the workflow is gone. */
export async function lockWorkflowForWrite(em: EntityManager, workflowId: string): Promise<void> {
  if (!(await lockWorkflowRow(em, workflowId)))
    throw new DomainError(`Workflow ${workflowId} not found`, 404);
}

/** The first lock of an env-pointer move, FOR NO KEY UPDATE: two moves of one workflow take turns, other writes still pass, and a delete still queues them; 404 when it is gone. */
export async function lockWorkflowForPointerMove(em: EntityManager, workflowId: string): Promise<void> {
  if (!(await lockRow(em, workflowId, 'FOR NO KEY UPDATE')))
    throw new DomainError(`Workflow ${workflowId} not found`, 404);
}
