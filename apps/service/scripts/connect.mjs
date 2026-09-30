import pg from 'pg';

/** Connect, or say in one line why not — a database still starting is expected at boot, not a crash. */
export async function connectOrExit(connectionString) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (err) {
    console.error(`Cannot connect to the database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  return client;
}
