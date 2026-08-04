import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

/** Canonical baseline schema — the same file the OSS `db:init` bootstrap applies. */
const SCHEMA_PATH = join(__dirname, '..', '..', 'db', 'schema.sql');
const E2E_DB_PREFIX = 'orchestr_e2e';

/**
 * e2e tests never touch the live database: each suite gets its OWN `orchestr_e2e_<rand>` built
 * from `db/schema.sql`, and stale ones are dropped here so no global teardown hook is needed.
 * Refresh the schema when the live DDL changes:
 *   docker exec orchestr-postgres-1 pg_dump -U orchestr -d orchestr --schema-only > db/schema.sql
 */
export async function createE2eDatabase(adminUrl: string): Promise<string> {
  const dbName = `${E2E_DB_PREFIX}_${randomBytes(4).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Reap only leftovers with NO live backend: dropping every match WITH (FORCE) killed the pool of
    // a suite still shutting down (57P01), which made the whole gate intermittently red.
    const stale = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE '${E2E_DB_PREFIX}%'
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    );
    for (const { datname } of stale.rows) {
      // A leftover database is harmless and gets reaped next run — never fail a suite over cleanup.
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const e2eUrl = withDatabase(adminUrl, dbName);
  // pg_dump emits psql meta-commands ('\' lines) the wire protocol can't execute — strip them.
  const schema = readFileSync(SCHEMA_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
  const db = new Client({ connectionString: e2eUrl });
  await db.connect();
  try {
    await db.query(schema);
  } finally {
    await db.end();
  }
  return e2eUrl;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
