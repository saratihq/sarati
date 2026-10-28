import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from '../../../service/test/support/test-db';
import { AgentProcess, answerKey, readToEnd, ServiceStub } from '../testing/composer-harness';
import { mintLocalSession } from '../testing/local-session';

const SECRET = 'shared-secret-off-the-data-volume';

describe('a composer turn cleared while it reads its key (e2e, throwaway Postgres database)', () => {
  const stub = new ServiceStub();
  let url: string;
  let agent: AgentProcess | undefined;

  beforeAll(async () => {
    url = await createE2eDatabase(ADMIN_URL);
    await stub.listen();
  }, 30_000);

  afterAll(async () => {
    await stub.close();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(url).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(async () => {
    agent = await AgentProcess.start({
      SECRET_KEY: SECRET,
      WORKFLOW_SERVICE_URL: stub.url,
      DATABASE_URL: url,
    });
  }, 60_000);

  afterEach(async () => {
    const running = agent;
    agent = undefined;
    await running?.stop();
  });

  it('ends interrupted without starting the Agent SDK', async () => {
    let answerTurnRead = (): void => undefined;
    const reading = new Promise<void>((resolve) =>
      stub.turnRead.set('cleared', (res) => {
        answerTurnRead = () => answerKey(res, 'sk-test');
        resolve();
      }),
    );
    const token = await mintLocalSession(SECRET, 'cleared');
    const turn = agent!.turn(token, { message: 'build me a workflow' });
    expect((await turn.next()).value).toMatchObject({ event: 'session' });
    await reading;

    const clear = await fetch(`${agent!.base}/api/composer/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ scratch: true }),
    });
    expect(await clear.json()).toEqual({ cleared: true });
    answerTurnRead();

    expect(await readToEnd(turn)).toEqual({
      events: [
        { event: 'error', data: { message: 'The conversation was interrupted — the build stopped.' } },
        { event: 'done', data: { session_id: expect.any(String), duration_ms: expect.any(Number) } },
      ],
      end: 'complete',
    });
    expect(stub.started).toBe(0);
  }, 20_000);
});
