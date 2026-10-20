/** The system database DBOS runs on: the one configured, else the app's with `_dbos` suffixed. */
export function systemDatabaseUrlOf(env: { dbosSystemDatabaseUrl: string; databaseUrl: string }): string {
  return env.dbosSystemDatabaseUrl || deriveDbosSystemDatabaseUrl(env.databaseUrl);
}

/**
 * Derive DBOS's system-database URL by suffixing the db name `_dbos` (query params preserved) —
 * its checkpoint tables must live in a SEPARATE database from the app's.
 */
export function deriveDbosSystemDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const db = url.pathname.replace(/^\//, '') || 'orchestr';
  url.pathname = `/${db}_dbos`;
  return url.toString();
}
