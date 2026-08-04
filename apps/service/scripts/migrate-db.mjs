#!/usr/bin/env node
/**
 * Apply every migration in db/migrations/ (sorted) to the database in
 * DATABASE_URL. Fresh databases don't need this — `pnpm db:init` creates the
 * full current schema; migrations bring an OLDER live database up to date.
 *
 * Every file in db/migrations/ MUST stay idempotent (IF NOT EXISTS / DO-block
 * guards) — this script runs all of them on every invocation, by design: no
 * ledger table, nothing to drift.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'db', 'migrations');
const ENV_PATH = join(here, '..', '.env');

// A real environment always wins; the .env file is the local-dev convenience.
try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // No .env (containers, CI) — the environment is expected to carry DATABASE_URL.
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — put it in apps/service/.env or the environment. Example:');
  console.error('  DATABASE_URL=postgresql://orchestr:orchestr@localhost:5432/orchestr_svc pnpm db:migrate');
  process.exit(1);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
    console.log(`applied ${file}`);
  }
  console.log(`schema is up to date (${files.length} migrations checked).`);
} catch (err) {
  console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
