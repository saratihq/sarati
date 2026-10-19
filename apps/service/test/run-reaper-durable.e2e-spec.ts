import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { listenOnLoopback } from './support/listen';
import { expectLastWaitStartsTheClock, expectResumedRunFinishes } from './support/resumed-run';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** The reaper on the rail production runs: DBOS on, run history on. */
describe('run durability reaper (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await db.end();
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it(
    'counts only the time in flight since a durable run resumed: approved after a long wait, it finishes, never reaped',
    () => expectResumedRunFinishes(app, db, app.get(RunReaperService), 'durable-resumed-1'),
    60_000,
  );

  it(
    'counts a durable run with two waits from the later one to end, never the first',
    () => expectLastWaitStartsTheClock(app, db, app.get(RunReaperService), 'durable-two-waits-1'),
    60_000,
  );
});
