import { randomBytes } from 'node:crypto';

import { startService, THIS_SERVICE } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const GUIDANCE =
  'DBOS_APP_VERSION must be set in production: to "orchestr-1", the value the images set, or ' +
  "to the value this install's runs already carry. DBOS resumes only the runs recorded under " +
  'the version it launches with, so never change it — not for a deploy, and not for an ' +
  'upgrade, whose engine changes ship under a new workflow name: a changed value strands ' +
  'every run in flight.';

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
    expect(started.log()).toContain(GUIDANCE);
    expect(started.log()).not.toMatch(/bump/i);
  }, 60_000);
});
