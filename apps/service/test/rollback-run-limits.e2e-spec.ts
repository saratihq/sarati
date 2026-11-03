import type { ServerResponse } from 'node:http';

import PgBoss from 'pg-boss';

import { ir } from './support/golden-docs';
import { lastRelease } from './support/earlier-build';
import { callStep, chain } from './support/limits-fixture';
import { MOCK_USER_ID, rollbackSuite } from './support/rollback';

const LAST_RELEASE = lastRelease();
const TIME_LIMIT =
  /^Run limit reached: this run was in flight for more than 2 s since it started or last resumed from a wait/;

/** A run this build budgets, across a rollback to the release it replaces and back (child processes, DBOS on, mock auth). */
describe(`a run's budget across a rollback to ${LAST_RELEASE.tag} and back (e2e)`, () => {
  const hits = new Map<string, number>();
  const holding = new Set<string>();
  const held: Array<{ path: string; res: ServerResponse }> = [];
  const answer = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  const rollback = rollbackSuite(LAST_RELEASE.sha, (req, res) => {
    const path = req.url ?? '';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (holding.has(path)) held.push({ path, res });
    else answer(res);
  });
  const release = (path: string): void => {
    holding.delete(path);
    for (const h of held.filter((x) => x.path === path)) answer(h.res);
  };
  const hitsOn = (path: string): number => hits.get(path) ?? 0;
  const runRow = async (runId: string) =>
    (
      await rollback
        .db()
        .query<{ status: string; error: string | null; steps_used: number; limits: unknown }>(
          `SELECT status, error, steps_used, limits FROM runtime_runs WHERE id = $1`,
          [`${MOCK_USER_ID}:${runId}`],
        )
    ).rows[0];
  const start = (runId: string, ids: string[]) =>
    rollback.post('/api/runs/async', {
      run_id: runId,
      workflow_ir: ir(
        ids.map((id) => callStep(rollback.fixtureUrl(''), id)),
        chain(ids),
      ),
    });

  it('a run this build admitted under limits carries on under the last release uncharged, and back here keeps its limits and its count', async () => {
    const env = { RUN_MAX_STEPS: '6' };
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'];
    holding.add('/b3');
    let service = await rollback.boot('this', env);
    expect((await start('budgeted', ids)).status).toBe(201);
    await rollback.eventually(
      () => Promise.resolve(hitsOn('/b3')),
      (n) => n === 1,
      'b3 in flight',
    );
    expect(await runRow('budgeted')).toMatchObject({ steps_used: 3 });
    await service.crash();

    release('/b3');
    holding.add('/b5');
    service = await rollback.boot('earlier');
    await rollback.eventually(
      () => Promise.resolve(hitsOn('/b5')),
      (n) => n === 1,
      `b5 in flight on ${LAST_RELEASE.tag}`,
    );
    expect(await runRow('budgeted')).toMatchObject({ status: 'running', steps_used: 3 });
    await service.crash();

    release('/b5');
    service = await rollback.boot('this', env);
    const row = await rollback.eventually(
      () => runRow('budgeted'),
      (r) => r !== undefined && r.status !== 'running',
      'the run ending back on this build',
    );

    expect(ids.map((id) => hitsOn(`/${id}`))).toEqual([1, 1, 2, 1, 2, 1, 1, 0]);
    expect(row).toMatchObject({ status: 'error', steps_used: 6 });
    expect(row!.error).toMatch(/^Run limit reached: this run took 6 steps/);
    expect(row!.limits).toEqual({ 'run.steps': 6, 'run.loop_rounds': 250_000, 'run.active_seconds': 86_400 });
    await service.crash();
  }, 300_000);

  // One reaper pass of the service booted last, asked for as its pg-boss cron asks.
  const reapNow = async (): Promise<void> => {
    const boss = new PgBoss({
      db: { executeSql: (text, values) => rollback.db().query(text, values) },
      schema: 'pgboss',
      supervise: false,
      schedule: false,
      migrate: false,
    });
    await boss.start();
    try {
      await boss.send('run-reap', {});
    } finally {
      await boss.stop({ graceful: false, close: false });
    }
  };

  it('a run this build stopped for its time stays stopped across a rollback and back', async () => {
    holding.add('/s1');
    let service = await rollback.boot('this', { PGBOSS_ENABLED: 'true' });
    expect((await start('stopped', ['s1', 's2'])).status).toBe(201);
    await rollback.eventually(
      () => Promise.resolve(hitsOn('/s1')),
      (n) => n === 1,
      's1 in flight',
    );
    // Its row now says it may run 2 s, where its workflow still carries the default: only the reaper can end it.
    await rollback
      .db()
      .query(`UPDATE runtime_runs SET limits = '{"run.active_seconds": 2}' WHERE id = $1`, [
        `${MOCK_USER_ID}:stopped`,
      ]);
    await new Promise((r) => setTimeout(r, 2_500));

    // A reaper pass while this service holds it finds it past its time, and stops it.
    await reapNow();
    const stopped = await rollback.eventually(
      () => runRow('stopped'),
      (r) => r?.status === 'error',
      'the reaper stopping the run',
    );
    expect(stopped!.error).toMatch(TIME_LIMIT);
    await rollback.eventually(rollback.workflows, (w) => w.stopped === 'CANCELLED', 'its workflow cancelled');
    release('/s1');
    await service.crash();

    service = await rollback.boot('earlier');
    await rollback.eventually(
      () => Promise.resolve(service.log()),
      (log) => log.includes('DBOS launched ('),
      `${LAST_RELEASE.tag} launching DBOS`,
    );
    expect(await runRow('stopped')).toMatchObject({ status: 'error', error: stopped!.error });
    await service.crash();

    service = await rollback.boot('this');
    expect(await runRow('stopped')).toMatchObject({ status: 'error', error: stopped!.error });
    expect((await rollback.workflows()).stopped).toBe('CANCELLED');
    expect(hitsOn('/s2')).toBe(0);
    await service.crash();
  }, 300_000);
});
