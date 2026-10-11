import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase, e2eDatabaseName, withDatabase } from './support/test-db';

/** The two scripts a container runs before the service, against a database that is not answering yet. */
describe('database scripts (no database needed)', () => {
  const run = (script: string) =>
    spawnSync(process.execPath, [join(__dirname, '..', 'scripts', script)], {
      env: { ...process.env, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' },
      encoding: 'utf8',
    });

  // The entrypoint retries on a non-zero exit, so this is an expected condition on a restart — it
  // used to print the driver's stack trace and the Node version, which reads as a crash.
  it.each(['init-db.mjs', 'migrate-db.mjs'])(
    '%s says in one line that it cannot connect, and exits 1',
    (script) => {
      const res = run(script);

      expect(res.status).toBe(1);
      expect(res.stderr.trim().split('\n')).toHaveLength(1);
      expect(res.stderr).toMatch(/^Cannot connect to the database: /);
    },
  );
});

describe('database scripts (e2e, isolated DB)', () => {
  const script = (name: string, url: string): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(__dirname, '..', 'scripts', name)], {
        env: { ...process.env, DATABASE_URL: url },
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('close', (code) => resolve({ code, stderr }));
    });

  // What the entrypoint runs on every boot: the schema onto an empty database, then the migrations.
  const boot = async (url: string): Promise<Array<{ code: number | null; stderr: string }>> => {
    const init = await script('init-db.mjs', url);
    return init.code === 0 ? [init, await script('migrate-db.mjs', url)] : [init];
  };

  const clean = { code: 0, stderr: '' };

  it('two migrate runs started together take turns, and both bring the schema up to date', async () => {
    const url = await createE2eDatabase(ADMIN_URL);
    for (let round = 0; round < 10; round++) {
      expect(await Promise.all([script('migrate-db.mjs', url), script('migrate-db.mjs', url)])).toEqual([
        clean,
        clean,
      ]);
    }
  }, 120_000);

  it('two first boots on one empty database take turns, and both come up', async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      for (let round = 0; round < 5; round++) {
        const name = e2eDatabaseName();
        await admin.query(`CREATE DATABASE ${name}`);
        const url = withDatabase(ADMIN_URL, name);
        try {
          expect(await Promise.all([boot(url), boot(url)])).toEqual([
            [clean, clean],
            [clean, clean],
          ]);
        } finally {
          await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        }
      }
    } finally {
      await admin.end();
    }
  }, 120_000);
});
