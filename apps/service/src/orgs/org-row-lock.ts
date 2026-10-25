import type { EntityManager, FindOptionsWhere } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { OrgInviteEntity } from '../database/entities/org-invite.entity';
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

/** The first lock of every write under an org: FOR KEY SHARE, so it waits for an org delete holding the org row and throws `gone` if the org went with it, never deadlocking with the delete's cascade or failing a foreign-key check on the org, and one that takes it first holds that delete off until it commits (constitution row 20). */
export function lockOrgForWrite(em: EntityManager, orgId: string, gone = orgGone()): Promise<void> {
  return lockOrg(em, orgId, 'FOR KEY SHARE', gone);
}

/** An invite's accept and revoke lock its row FOR UPDATE after the org row, so they take turns on one invite and each judges the row as the other left it (constitution row 20). */
export function lockInvite(
  em: EntityManager,
  where: FindOptionsWhere<OrgInviteEntity>,
): Promise<OrgInviteEntity | null> {
  return em.findOne(OrgInviteEntity, { where, lock: { mode: 'pessimistic_write' } });
}

/** An org delete's locks before anything it deletes: the org row FOR UPDATE, granted once every {@link lockOrgForWrite} write holding it has committed, so `refuse` then sees what they wrote and every later write, a second delete included, waits and answers 404 if the org goes; then the org's connections FOR UPDATE, so no slot joins them; then, in one id order, its environments FOR UPDATE, the order a workflow delete takes them in, and every other environment holding one of those connections' slots FOR KEY SHARE, so it takes turns with that environment's delete or its org's (constitution rows 11 and 20); returns the connections' ids. */
export async function lockOrgForDelete(
  em: EntityManager,
  orgId: string,
  refuse: () => Promise<void>,
): Promise<string[]> {
  await lockOrg(em, orgId, 'FOR UPDATE', orgGone());
  await refuse();
  const connections = await rawQuery<{ id: string }>(
    em,
    `SELECT id FROM connections WHERE org_id = $1 ORDER BY id FOR UPDATE`,
    [orgId],
  );
  const ids = connections.map((row) => row.id);
  const environments = await rawQuery<{ id: string; own: boolean }>(
    em,
    `SELECT id, org_id = $1 AS own FROM environments
      WHERE org_id = $1
         OR id IN (SELECT environment_id FROM environment_connections WHERE connection_id = ANY($2::uuid[]))
      ORDER BY id`,
    [orgId, ids],
  );
  for (const { id, own } of environments) {
    const mode = own ? 'FOR UPDATE' : 'FOR KEY SHARE';
    await rawQuery(em, `SELECT 1 FROM environments WHERE id = $1 ${mode}`, [id]);
  }
  return ids;
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
