import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M042 = readFileSync(join(__dirname, '..', 'db', 'migrations', '042_sso_sign_in.sql'), 'utf8');

const TABLES = ['user_identities', 'oidc_login_states'];

/** Columns, constraints and indexes of what 042 adds, so a migrated database can be compared with a fresh one. */
async function shapeOf(db: Client): Promise<unknown> {
  const columns = await db.query(
    `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name = ANY($1) OR (table_name = 'users' AND column_name = 'email_verified'))
      ORDER BY table_name, column_name`,
    [TABLES],
  );
  const constraints = await db.query(
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid::regclass::text = ANY($1) ORDER BY conname`,
    [TABLES.map((t) => t)],
  );
  const indexes = await db.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1) ORDER BY indexname`,
    [TABLES],
  );
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

describe('migration 042: single sign-on identities, sign-in state and email trust (scratch DBs)', () => {
  let migrated: Client;
  let fresh: Client;

  beforeAll(async () => {
    migrated = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    fresh = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await Promise.all([migrated.connect(), fresh.connect()]);
    await migrated.query('DROP TABLE user_identities, oidc_login_states');
    await migrated.query('ALTER TABLE users DROP COLUMN email_verified');
  }, 30_000);

  afterAll(async () => {
    await Promise.all([migrated.end(), fresh.end()]);
  });

  it('creates both tables and the column once, keeps an existing account matchable, a re-run keeps their rows, and the result matches a fresh schema.sql', async () => {
    const existing = randomUUID();
    await migrated.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'e@example.com', 'E', now(), now())`,
      [existing],
    );
    await migrated.query(M042);
    const trusted = await migrated.query(`SELECT email_verified FROM users WHERE id = $1`, [existing]);
    expect(trusted.rows).toEqual([{ email_verified: true }]);
    const user = randomUUID();
    await migrated.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'm@example.com', 'M', now(), now())`,
      [user],
    );
    await migrated.query(
      `INSERT INTO user_identities (id, user_id, issuer, subject) VALUES ($1, $2, 'https://idp.example.com/', 'sub-1')`,
      [randomUUID(), user],
    );
    await migrated.query(M042);

    const kept = await migrated.query(`SELECT subject FROM user_identities`);
    expect(kept.rows).toEqual([{ subject: 'sub-1' }]);
    expect(await shapeOf(migrated)).toEqual(await shapeOf(fresh));
  });

  it('holds one account per identity and one identity per issuer per account, and drops both with the account', async () => {
    const user = randomUUID();
    await fresh.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'f@example.com', 'F', now(), now())`,
      [user],
    );
    const identity = (subject: string, issuer = 'https://idp.example.com/') =>
      fresh.query(`INSERT INTO user_identities (id, user_id, issuer, subject) VALUES ($1, $2, $3, $4)`, [
        randomUUID(),
        user,
        issuer,
        subject,
      ]);
    await identity('sub-1');
    await expect(identity('sub-2')).rejects.toThrow(/user_identities_user_issuer_key/);
    await identity('sub-1', 'https://other.example.com/');
    await fresh.query(`DELETE FROM users WHERE id = $1`, [user]);
    const left = await fresh.query(`SELECT 1 FROM user_identities WHERE user_id = $1`, [user]);
    expect(left.rows).toEqual([]);
  });
});
