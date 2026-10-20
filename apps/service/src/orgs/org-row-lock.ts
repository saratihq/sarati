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

/** An org delete's first locks: the org row FOR UPDATE, so a second delete and every {@link lockOrgForWrite} write wait for it and then answer 404, then its environments in id order, the order a workflow delete takes them in (constitution rows 11 and 20). */
export async function lockOrgForDelete(em: EntityManager, orgId: string): Promise<void> {
  await lockOrg(em, orgId, 'FOR UPDATE', orgGone());
  await rawQuery(em, `SELECT 1 FROM environments WHERE org_id = $1 ORDER BY id FOR UPDATE`, [orgId]);
}

/** A connection delete's locks before its cascade empties their slots: the connections FOR UPDATE, so no slot joins them, then the org of every environment holding one of their slots, FOR KEY SHARE in id order (constitution row 20); returns the ids still there. */
export async function lockConnectionsForDelete(
  em: EntityManager,
  connectionIds: string[],
): Promise<string[]> {
  const locked = await rawQuery<{ id: string }>(
    em,
    `SELECT id FROM connections WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [connectionIds],
  );
  const ids = locked.map((row) => row.id);
  await rawQuery(
    em,
    `SELECT 1 FROM organizations
      WHERE id IN (SELECT e.org_id FROM environment_connections ec
                     JOIN environments e ON e.id = ec.environment_id
                    WHERE ec.connection_id = ANY($1::uuid[]))
      ORDER BY id FOR KEY SHARE`,
    [ids],
  );
  return ids;
}
