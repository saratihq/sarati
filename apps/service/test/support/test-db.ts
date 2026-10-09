import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { DEFAULT_DATABASE_URL } from '../../src/config/env.config';

/** Canonical baseline schema — the same file the OSS `db:init` bootstrap applies. */
const SCHEMA_PATH = join(__dirname, '..', '..', 'db', 'schema.sql');
const E2E_DB_PREFIX = 'orchestr_e2e';
// No suite runs this long, and a younger database may belong to a suite that hasn't connected to it yet.
const REAP_AFTER_MS = 2 * 60 * 60 * 1000;

/** The database every suite creates its throwaway copy from — the app's own default, never a second one. */
export const ADMIN_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/**
 * e2e tests never touch the live database: each suite gets its OWN `orchestr_e2e_<rand>` built
 * from `db/schema.sql`, and stale ones are dropped here so no global teardown hook is needed.
 * Refresh the schema when the live DDL changes:
 *   docker exec orchestr-postgres-1 pg_dump -U orchestr -d orchestr --schema-only > db/schema.sql
 */
export async function createE2eDatabase(adminUrl: string): Promise<string> {
  const dbName = e2eDatabaseName();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Reap only old leftovers with no live backend: a fresh, not-yet-connected database belongs to a suite still starting.
    const idle = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE '${E2E_DB_PREFIX}%'
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    );
    for (const { datname } of idle.rows.filter((row) => isReapable(row.datname))) {
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

/** A throwaway e2e database name stamped with its creation time, so cleanup only ever reaps old leftovers. */
export function e2eDatabaseName(): string {
  return `${E2E_DB_PREFIX}_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

// An unstamped name predates the stamp, so nothing still creates it.
function isReapable(datname: string): boolean {
  const stamp = new RegExp(`^${E2E_DB_PREFIX}_(\\d{13})_`).exec(datname);
  return stamp === null || Date.now() - Number(stamp[1]) > REAP_AFTER_MS;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
