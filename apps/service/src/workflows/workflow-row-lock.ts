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

/** The first lock of an env-pointer move and of the reconciler's activation insert, FOR NO KEY UPDATE: two of them on one workflow take turns, other writes still pass, and a delete still queues them; 404 when it is gone. */
export async function lockWorkflowForPointerMove(em: EntityManager, workflowId: string): Promise<void> {
  if (!(await lockRow(em, workflowId, 'FOR NO KEY UPDATE')))
    throw new DomainError(`Workflow ${workflowId} not found`, 404);
}

/** A workflow delete's lock after its row and before it touches a run: the environments its runs ran in, FOR KEY SHARE in id order, the order an org delete takes them in, so it and an environment or org delete over the same runs never each hold what the other waits for (constitution row 11). */
export async function lockRunEnvironments(em: EntityManager, workflowId: string): Promise<void> {
  await rawQuery(
    em,
    `SELECT 1 FROM environments e
      WHERE e.id IN (SELECT r.environment_id FROM runtime_runs r WHERE r.workflow_id = $1)
      ORDER BY e.id
        FOR KEY SHARE OF e`,
    [workflowId],
  );
}

/** A workflow delete's un-promote, after its workflow row: the environments its pointers are on, FOR SHARE in id order, since every write of an environment's pointers takes the environment row first (constitution row 11). */
export async function lockPointerEnvironments(em: EntityManager, workflowId: string): Promise<void> {
  await rawQuery(
    em,
    `SELECT 1 FROM environments e
      WHERE e.id IN (SELECT p.environment_id FROM workflow_env_pointers p WHERE p.workflow_id = $1)
      ORDER BY e.id
        FOR SHARE OF e`,
    [workflowId],
  );
}
