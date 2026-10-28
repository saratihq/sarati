import type { Client } from 'pg';

/** A user's personal org, which the user owns as its one member (constitution row 22). */
export interface PersonalOrg {
  id: string;
  userId: string;
  name: string;
}

/** Inserts each personal org with its owner's membership in one statement, so the database's check that a personal org's owner is its member holds when it commits. */
export async function insertPersonalOrgs(db: Pick<Client, 'query'>, ...orgs: PersonalOrg[]): Promise<void> {
  await db.query(
    `WITH org AS (
       INSERT INTO organizations (id, name, is_personal, personal_owner_id, created_at, updated_at)
       SELECT id, name, true, user_id, now(), now()
         FROM unnest($1::uuid[], $2::text[], $3::uuid[]) AS seed(id, name, user_id)
       RETURNING id, personal_owner_id)
     INSERT INTO org_members (id, org_id, user_id, role, is_personal, created_at)
     SELECT gen_random_uuid(), org.id, org.personal_owner_id, 'owner', true, now() FROM org`,
    [orgs.map((o) => o.id), orgs.map((o) => o.name), orgs.map((o) => o.userId)],
  );
}
