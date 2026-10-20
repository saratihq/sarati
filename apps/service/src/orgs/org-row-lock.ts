import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { rawQuery } from '../database/raw-query';

const orgGone = (): DomainError => new DomainError('Organization not found', 404);

async function lockOrg(
  em: EntityManager,
  orgId: string,
  mode: 'FOR KEY SHARE' | 'FOR UPDATE',
  gone: DomainError,
): Promise<void> {
  const rows = await rawQuery(em, `SELECT 1 FROM organizations WHERE id = $1 ${mode}`, [orgId]);
  if (rows.length === 0) throw gone;
}

/** The first lock of every write under an org: FOR KEY SHARE, so it queues behind an org delete and throws `gone` once the org is gone, never deadlocking with the delete's cascade or failing a foreign-key check on the org (constitution row 20). */
export function lockOrgForWrite(em: EntityManager, orgId: string, gone = orgGone()): Promise<void> {
  return lockOrg(em, orgId, 'FOR KEY SHARE', gone);
}

/** An org delete's first lock, FOR UPDATE: a second delete and every {@link lockOrgForWrite} write wait for it, then answer 404. */
export function lockOrgForDelete(em: EntityManager, orgId: string): Promise<void> {
  return lockOrg(em, orgId, 'FOR UPDATE', orgGone());
}
