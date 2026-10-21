import { DBOS } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';

import { withoutAdminServer } from '../../src/dbos/dbos-config';
import { ADMIN_URL, e2eDatabaseName, withDatabase } from './test-db';

/** DBOS launched on a system database of a suite's own, and how to stop it and drop that database. */
export interface ThrowawayDbos {
  /** The system database's URL, for reading what DBOS recorded. */
  url: string;
  shutdown(): Promise<void>;
}

async function onAdmin(statements: string[]): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const statement of statements) await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/** Launches DBOS as `name` on a fresh, empty system database; DBOS builds its checkpoint schema on launch. */
export async function launchThrowawayDbos(name: string): Promise<ThrowawayDbos> {
  const database = `${e2eDatabaseName()}_dbos`;
  await onAdmin([`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, `CREATE DATABASE ${database}`]);
  const url = withDatabase(ADMIN_URL, database);
  DBOS.setConfig(withoutAdminServer({ name, systemDatabaseUrl: url }));
  await DBOS.launch();
  return {
    url,
    shutdown: async () => {
      await DBOS.shutdown();
      await onAdmin([`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
    },
  };
}
