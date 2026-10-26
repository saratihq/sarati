import { PARK_DELAY_ABOVE_MS } from '../src/runtime/timer-wait';
import { lastRelease } from './support/earlier-build';
import { MOCK_USER_ID, rollbackSuite } from './support/rollback';

const WINDOW_MS = 10 * 60_000;
const PARKED_DELAY_MS = PARK_DELAY_ABOVE_MS + 1_000;
const LAST_RELEASE = lastRelease();

/** The release this build replaces, booted on runs this build started and booted back over them (child processes, DBOS on, mock auth). */
describe(`a run this version starts, across a rollback to ${LAST_RELEASE.tag} and back (e2e)`, () => {
  let calls = 0;
  // The first call is held open until the crash, so the step is in flight as the service goes down.
  const rollback = rollbackSuite(LAST_RELEASE.sha, (req, res) => {
    if (req.url !== '/call') return;
    calls += 1;
    if (calls > 1) res.end('{"ok":true}');
  });
  const { post, eventually, runs, workflows } = rollback;

  const decide = async (runId: string, topic: string, stepKey: string): Promise<void> => {
    const res = await post(`/api/runs/${runId}/events`, { topic, step_key: stepKey, payload: { topic } });
    expect(res.status).toBe(200);
  };
  const forkDeciders = async (): Promise<Record<string, string | null>> =>
    Object.fromEntries(
      (
        await rollback
          .db()
          .query<{ step_key: string; decided_by: string | null }>(
            `SELECT step_key, decided_by FROM runtime_run_steps WHERE run_id = $1 AND step_key LIKE 'fork|%'`,
            [`${MOCK_USER_ID}:fanned`],
          )
      ).rows.map((r) => [r.step_key, r.decided_by]),
    );

  it('carries on there — decided, woken and its in-flight step run once more — and is picked up where it was on coming back', async () => {
    const approve = (id: string, topic: string) => ({
      kind: 'waitForEvent',
      id,
      topic,
      timeoutMs: WINDOW_MS,
    });
    const plans: Record<string, unknown[]> = {
      decided: [approve('approve', 'approval')],
      untouched: [approve('approve', 'approval')],
      fanned: [
        {
          kind: 'parallel',
          id: 'fork',
          branches: [[approve('legal', 'legal')], [approve('finance', 'finance')]],
        },
      ],
      called: [
        {
          kind: 'action',
          id: 'call',
          actionId: 'http.send_request',
          props: { method: 'GET', url: rollback.fixtureUrl('/call') },
        },
      ],
      timed: [{ kind: 'delay', id: 'pause', ms: PARKED_DELAY_MS }],
    };

    let service = await rollback.boot('this');
    for (const [runId, nodes] of Object.entries(plans)) {
      expect(
        (await post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } })).status,
      ).toBe(201);
    }
    await eventually(
      () =>
        rollback.db().query<{ topic: string }>(
          `SELECT split_part(waiting_topic, ':', 2) AS topic FROM runtime_run_steps
            WHERE waiting_topic IS NOT NULL AND finished_at IS NULL`,
        ),
      (res) =>
        res.rows.filter((r) => r.topic === '').length === 4 &&
        res.rows.filter((r) => r.topic === 'timer').length === 1 &&
        calls === 1,
      'four approvals and a Wait step parked, and the call in flight',
    );
    await service.crash();

    service = await rollback.boot('earlier');
    await eventually(
      () => Promise.resolve(service.log()),
      (log) => log.includes('DBOS launched ('),
      `${LAST_RELEASE.tag} launching DBOS`,
    );
    expect(service.log()).not.toMatch(/Recovery of workflow .* failed/);
    const inbox = (await (await fetch(`${service.base}/api/runs/waiting`)).json()) as {
      runs: Array<{ run_id: string; step_key: string | null }>;
    };
    expect(inbox.runs.map((r) => `${r.run_id} ${r.step_key}`).sort()).toEqual([
      'decided approve',
      'fanned fork|0/legal',
      'fanned fork|1/finance',
      'untouched approve',
    ]);
    await decide('decided', 'approval', 'approve');
    await decide('fanned', 'legal', 'fork|0/legal');
    const there = await eventually(
      runs,
      (now) =>
        now.decided?.status === 'completed' &&
        now.called?.status === 'completed' &&
        now.timed?.status === 'completed',
      `the decided run, the called run and the Wait step finishing on ${LAST_RELEASE.tag}`,
      PARKED_DELAY_MS / 100,
    );
    expect(there.decided!.decided_by).toBe(MOCK_USER_ID);
    expect(calls).toBe(2);
    expect(await forkDeciders()).toEqual({ 'fork|0/legal': MOCK_USER_ID, 'fork|1/finance': null });
    expect(there).toMatchObject({ untouched: { status: 'waiting' }, fanned: { status: 'waiting' } });
    await service.crash();

    await rollback.boot('this');
    await decide('untouched', 'approval', 'approve');
    await decide('fanned', 'finance', 'fork|1/finance');
    const back = await eventually(
      runs,
      (now) => now.untouched?.status === 'completed' && now.fanned?.status === 'completed',
      'the untouched and the fanned run completing',
    );
    expect(back).toMatchObject({
      decided: there.decided,
      called: there.called,
      timed: there.timed,
      untouched: { error: null, decided_by: MOCK_USER_ID },
    });
    expect(await forkDeciders()).toEqual({ 'fork|0/legal': MOCK_USER_ID, 'fork|1/finance': MOCK_USER_ID });
    expect(calls).toBe(2);
    await eventually(
      workflows,
      (now) => Object.keys(plans).every((runId) => now[runId] === 'SUCCESS'),
      'every run’s workflow succeeding',
    );
  }, 300_000);
});
