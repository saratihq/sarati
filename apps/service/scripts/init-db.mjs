#!/usr/bin/env node
/**
 * Applies db/schema.sql to the database in DATABASE_URL — a fresh Postgres
 * becomes a working database with one command (`pnpm db:init`).
 *
 * Idempotent: safe to run against an empty database, and a NO-OP (skip + exit 0)
 * when the schema is already present (an existing `users` table) — never clobbers
 * data. This lets `db:release` run it on every deploy; migrations then bring an
 * older database up to date.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, '..', 'db', 'schema.sql');
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
  console.error('  DATABASE_URL=postgresql://orchestr:orchestr@localhost:5432/orchestr_svc pnpm db:init');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const existing = await client.query(
    `SELECT to_regclass('public.users') IS NOT NULL AS present`,
  );
  if (existing.rows[0]?.present) {
    // Already initialized — skip (idempotent) rather than clobber. `db:migrate`
    // (run next by `db:release`) evolves an older schema forward.
    console.log('Schema already present (a `users` table exists) — skipping db:init.');
    process.exit(0);
  }

  // pg_dump emits psql meta-commands (lines starting with '\') that the wire
  // protocol cannot execute — strip them; everything else is plain SQL.
  const schema = readFileSync(SCHEMA_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');

  await client.query(schema);
  console.log('Schema applied. The database is ready.');
} finally {
  await client.end();
}
