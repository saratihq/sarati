import { PROD_ENV, UAT_ENV } from './env-name';

/** The environments an org is created with. */
export const DEFAULT_ENVS: readonly string[] = [PROD_ENV, 'staging', UAT_ENV];

/** What the seed needs: a transaction's EntityManager, or a pg client. */
interface Sql {
  query(text: string, params: unknown[]): Promise<unknown>;
}

/** Create a new org's default environments, in the transaction that inserts the org, and record that it has them. */
export async function seedDefaultEnvironments(sql: Sql, orgId: string): Promise<void> {
  await sql.query(
    `WITH org AS (UPDATE organizations SET environments_seeded_at = now() WHERE id = $1 RETURNING id)
     INSERT INTO environments (org_id, name, is_prod)
     SELECT org.id, name, name = $3 FROM org, unnest($2::text[]) AS name`,
    [orgId, DEFAULT_ENVS, PROD_ENV],
  );
}
