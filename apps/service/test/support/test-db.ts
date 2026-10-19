import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { DEFAULT_DATABASE_URL } from '../../src/config/env.config';

/** Canonical baseline schema — the same file the OSS `db:init` bootstrap applies. */
const SCHEMA_PATH = join(__dirname, '..', '..', 'db', 'schema.sql');
const E2E_DB_PREFIX = 'orchestr_e2e';
const STAMPED = new RegExp(`^${E2E_DB_PREFIX}_(\\d{13})_[0-9a-z_]+$`);
const REAP_BUDGET_MS = 10_000;

/** The env var the e2e globalSetup sets, and every suite inherits: the id each database of this jest run carries. */
export const E2E_RUN_ID_ENV = 'E2E_RUN_ID';

/** Age past which a run's globalSetup reaps an idle e2e database: no run lasts this long. */
export const REAP_AFTER_MS = 2 * 60 * 60 * 1000;

/** The database every suite creates its throwaway copy from — the app's own default, never a second one. */
export const ADMIN_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/** What one stale reap did: the databases it dropped, those Postgres refused, and how many stale ones are left. */
export interface StaleReap {
  dropped: string[];
  refused: string[];
  remaining: number;
}

/**
 * e2e tests never touch the live database: each suite gets its OWN throwaway database built from
 * `db/schema.sql`, which the run's globalTeardown drops. Refresh the schema when the live DDL changes:
 *   docker exec orchestr-postgres-1 pg_dump -U orchestr -d orchestr --schema-only > db/schema.sql
 */
export async function createE2eDatabase(adminUrl: string): Promise<string> {
  const dbName = e2eDatabaseName();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
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

/** A throwaway e2e database name: `orchestr_e2e_<created ms>_r<run id>_<rand>`. */
export function e2eDatabaseName(runId = e2eRunId(), createdAt = Date.now()): string {
  return `${E2E_DB_PREFIX}_${createdAt}_r${runId}_${randomBytes(4).toString('hex')}`;
}

/** This jest run's id, which its globalSetup sets. */
export function e2eRunId(): string {
  const runId = process.env[E2E_RUN_ID_ENV];
  if (!runId || !/^[0-9a-f]+$/.test(runId)) {
    throw new Error(
      `${E2E_RUN_ID_ENV} is unset: run this suite under a jest config whose globalSetup is test/support/global-setup.ts`,
    );
  }
  return runId;
}

/** The stamped e2e databases among `names` created more than `olderThanMs` before `now`, oldest first. */
export function staleE2eDatabases(names: string[], now: number, olderThanMs: number): string[] {
  return names
    .flatMap((name) => {
      const stamp = STAMPED.exec(name);
      return stamp ? [{ name, createdAt: Number(stamp[1]) }] : [];
    })
    .filter((db) => now - db.createdAt > olderThanMs)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((db) => db.name);
}

/** Drops idle stale e2e databases oldest first until `budgetMs` is spent, always at least one so a backlog shrinks. */
export async function reapStaleE2eDatabases(
  adminUrl: string,
  { olderThanMs = REAP_AFTER_MS, budgetMs = REAP_BUDGET_MS } = {},
): Promise<StaleReap> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const idle = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname ~ '^${E2E_DB_PREFIX}_'
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    );
    const stale = staleE2eDatabases(
      idle.rows.map((row) => row.datname),
      Date.now(),
      olderThanMs,
    );
    const deadline = Date.now() + budgetMs;
    const reap: StaleReap = { dropped: [], refused: [], remaining: stale.length };
    for (const name of stale) {
      try {
        // No FORCE: Postgres refuses a database a backend has connected to since the scan.
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)}`);
        reap.dropped.push(name);
        reap.remaining--;
      } catch (err) {
        reap.refused.push(`${name}: ${(err as Error).message}`);
      }
      if (Date.now() >= deadline) break;
    }
    return reap;
  } finally {
    await admin.end();
  }
}

/** Drops every database jest run `runId` created, DBOS system databases included; returns the ones that failed. */
export async function dropRunDatabases(adminUrl: string, runId: string): Promise<string[]> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const failed: string[] = [];
  try {
    const own = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname ~ $1`, [
      `^${E2E_DB_PREFIX}_\\d{13}_r${runId}_`,
    ]);
    for (const { datname } of own.rows) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(datname)} WITH (FORCE)`);
      } catch (err) {
        failed.push(`${datname}: ${(err as Error).message}`);
      }
    }
  } finally {
    await admin.end();
  }
  return failed;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
