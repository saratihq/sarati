import { randomBytes } from 'node:crypto';

import { startService, THIS_SERVICE } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A production boot with no DBOS_APP_VERSION, in a process of its own. */
describe('DBOS_APP_VERSION in production (e2e)', () => {
  it('stops a boot without it, saying to set it once and never change it', async () => {
    const started = await startService({
      service: THIS_SERVICE,
      databaseUrl: await createE2eDatabase(ADMIN_URL),
      env: {
        ENVIRONMENT: 'production',
        MOCK_AUTH: 'false',
        SECRET_KEY: randomBytes(32).toString('hex'),
        DBOS_APP_VERSION: '',
      },
    });
    const refused = await started.answered.then(
      () => null,
      (err: Error) => err.message,
    );
    await started.crash();

    expect(refused).toMatch(/^the service exited as it booted/);
    const log = started.log();
    expect(log).toContain('DBOS_APP_VERSION must be set in production: to "orchestr-1"');
    expect(log).toContain('never change it');
    expect(log).toContain('a changed value strands every run in flight');
    expect(log).not.toMatch(/bump/i);
  }, 60_000);
});
