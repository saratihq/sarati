import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
