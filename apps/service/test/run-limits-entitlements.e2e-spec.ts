import request from 'supertest';

import { ENTITLEMENTS_PROVIDER, type EntitlementsProvider } from '../src/entitlements/entitlements';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { ir, irNode } from './support/golden-docs';
import {
  bootLimitsApp,
  callStep,
  chain,
  edgeOn,
  HitFixture,
  type LimitsApp,
  MOCK_USER_ID,
  runRow,
} from './support/limits-fixture';

const ROW_MOST = 2_147_483_647;
const ANOTHER_USER_ID = '00000000-0000-0000-0000-000000000002';
const METRICS = [
  'run.steps',
  'run.loop_rounds',
  'run.active_seconds',
  'workspace.running_runs',
  'workspace.unfinished_runs',
];

/** The run budget asks the entitlements seam for each workspace's numbers, so a provider other than the open core's sets them (in process, DBOS on). */
describe('run limits through the entitlements seam (e2e, DBOS on)', () => {
  const fixture = new HitFixture();
  const asked: Array<{ orgId: string | null; metric: string }> = [];
  const stepsFor = new Map<string | null, number>();
  const byWorkspace = (orgId: string | null, metric: string): number | null =>
    metric === 'run.steps' ? (stepsFor.get(orgId) ?? null) : null;
  let answer = byWorkspace;
  const provider: EntitlementsProvider = {
    allows: () => Promise.resolve(true),
    limitFor: (orgId, metric) => {
      asked.push({ orgId, metric });
      return Promise.resolve(answer(orgId, metric));
    },
  };
  let limits: LimitsApp;
  let personal = '';
  let other = '';
  const http = () => request(limits.app.getHttpServer());
  const ids = (prefix: string) => Array.from({ length: 6 }, (_, i) => `${prefix}${i + 1}`);
  const hitsUnder = (prefix: string) => fixture.countUnder(`/${prefix}`);
  // A raw plan's steps, each a call to the fixture.
  const planSteps = (prefix: string) =>
    ids(prefix).map((id) => ({
      kind: 'action',
      id,
      actionId: 'http.send_request',
      props: { method: 'GET', url: `${fixture.base}/${id}` },
    }));

  beforeAll(async () => {
    await fixture.listen();
    limits = await bootLimitsApp({}, (builder) =>
      builder.overrideProvider(ENTITLEMENTS_PROVIDER).useValue(provider),
    );
    other = (await http().post('/api/orgs').send({ name: 'Bigger plan' }).expect(201)).body.id as string;
    personal = (
      await limits.db.query<{ id: string }>(
        `SELECT id FROM organizations WHERE personal_owner_id IS NOT NULL`,
      )
    ).rows[0]!.id;
    stepsFor.set(personal, 2).set(other, 4).set(null, 3);
  }, 60_000);

  afterAll(async () => {
    await limits.close();
    await fixture.close();
  }, 60_000);

  afterEach(() => {
    answer = byWorkspace;
    fixture.releaseAll();
  });

  const run = (runId: string, steps: string[]) =>
    http()
      .post('/api/runs/from-ir')
      .send({
        run_id: runId,
        workflow_ir: ir(
          steps.map((id) => callStep(fixture.base, id)),
          chain(steps),
        ),
      });

  it('two workspaces with different numbers each stop at their own, a raw plan in the org it was started in, and a called run under its caller’s', async () => {
    const fromIr = (runId: string, prefix: string, org?: string) => {
      let req = http().post('/api/runs/from-ir');
      if (org) req = req.set('X-Org-Id', org);
      const stepIds = ids(prefix);
      return req.send({
        run_id: runId,
        workflow_ir: ir(
          stepIds.map((id) => callStep(fixture.base, id)),
          chain(stepIds),
        ),
      });
    };
    const called = await http()
      .post('/api/deploy')
      .send({
        workflow_json: ir(
          [
            irNode('trigger', 'orchestr:tool_trigger', {
              tool_name: 'counted_under_caller',
              description: 'six steps',
              inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
            }),
            ...ids('c').map((id) => callStep(fixture.base, id)),
          ],
          [edgeOn('trigger', 'c1'), ...chain(ids('c'))],
        ),
      })
      .expect(201);
    asked.length = 0;

    expect((await fromIr('in-personal', 'p')).status).toBe(422);
    expect((await fromIr('in-other', 'o', other)).status).toBe(422);
    const raw = await http()
      .post('/api/runs')
      .set('X-Org-Id', other)
      .send({ run_id: 'raw-in-other', plan: { id: 'raw', nodes: planSteps('r') } });
    expect(raw.status).toBe(422);
    const caller = await http()
      .post('/api/runs/from-ir')
      .send({
        run_id: 'calls-in-personal',
        workflow_ir: ir(
          [irNode('call', 'orchestr:call_workflow', { workflow_id: called.body.workflow_id })],
          [],
        ),
      });
    expect(caller.status).toBe(422);

    expect({
      personal: hitsUnder('p'),
      other: hitsUnder('o'),
      raw: hitsUnder('r'),
      called: hitsUnder('c'),
    }).toEqual({ personal: 2, other: 4, raw: 4, called: 1 });
    expect((await runRow(limits.db, 'raw-in-other')).limits).toMatchObject({ 'run.steps': 4 });
    expect(
      (await limits.db.query(`SELECT org_id FROM runtime_runs WHERE run_id = 'raw-in-other'`)).rows,
    ).toEqual([{ org_id: other }]);
    // Asked once per metric for each admission, for the run's own workspace, and never again for a run it calls.
    expect(asked).toEqual(
      [personal, other, other, personal].flatMap((orgId) => METRICS.map((metric) => ({ orgId, metric }))),
    );
  }, 60_000);

  it('a provider answering more than a run’s row can count holds the run to the most it can, so every step runs and the reaper still sweeps; one answering no limit at all fails the admission, recording nothing', async () => {
    answer = (_orgId, metric) => (metric.startsWith('run.') ? Number.MAX_SAFE_INTEGER : 10_000_000_000);

    const big = await run('held-to-most', ids('big'));

    expect(big.status).toBe(201);
    expect(hitsUnder('big')).toBe(6);
    expect(await runRow(limits.db, 'held-to-most')).toMatchObject({
      status: 'completed',
      steps_used: 6,
      limits: { 'run.steps': ROW_MOST, 'run.loop_rounds': ROW_MOST, 'run.active_seconds': ROW_MOST },
    });
    fixture.hold('/inflight1');
    const inFlight = run('in-flight', ['inflight1']).then((res) => res);
    await fixture.untilHit('/inflight1');
    await expect(limits.app.get(RunReaperService).reapStale()).resolves.toMatchObject({ stoppedRuns: 0 });
    fixture.release('/inflight1');
    expect((await inFlight).status).toBe(201);

    answer = () => -1;
    expect((await run('no-limit-at-all', ['never'])).status).toBe(500);
    expect(fixture.count('/never')).toBe(0);
    expect(
      (await limits.db.query(`SELECT 1 FROM runtime_runs WHERE run_id = 'no-limit-at-all'`)).rowCount,
    ).toBe(0);
  }, 60_000);

  it('a branch test’s two sides are asked for their workspace’s numbers once, and both run under that one answer', async () => {
    const doc = (side: string) => ({
      ...ir(
        [irNode('trigger', 'orchestr:trigger', {}), ...ids(side).map((id) => callStep(fixture.base, id))],
        [edgeOn('trigger', `${side}1`), ...chain(ids(side))],
      ),
      name: 'tested together',
    });
    const wf = (
      await http()
        .post('/api/deploy')
        .send({ workflow_json: doc('tb') })
        .expect(201)
    ).body.workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'change' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: doc('th'), branch: 'change' })
      .expect(201);
    const review = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'change', title: 'Change' })
        .expect(201)
    ).body.id as string;
    asked.length = 0;

    const tested = await http().post(`/api/workflows/${wf}/reviews/${review}/test`).send({});

    expect(tested.status).toBe(201);
    expect({ base: hitsUnder('tb'), head: hitsUnder('th') }).toEqual({ base: 2, head: 2 });
    const sides = await limits.db.query<{ limits: unknown }>(
      `SELECT limits FROM runtime_runs WHERE review_id = $1`,
      [review],
    );
    expect(sides.rows.map((row) => row.limits)).toEqual([
      expect.objectContaining({ 'run.steps': 2 }),
      expect.objectContaining({ 'run.steps': 2 }),
    ]);
    expect(asked).toEqual(METRICS.map((metric) => ({ orgId: personal, metric })));
  }, 60_000);

  // Last, since it takes the caller's personal workspace away.
  it('a run started by a caller with no workspace at all is asked for none, counted among its own, and stops at the provider’s answer for none', async () => {
    await limits.db.query(`DELETE FROM organizations WHERE id = $1`, [personal]);
    answer = (orgId, metric) => (metric === 'workspace.unfinished_runs' ? 1 : byWorkspace(orgId, metric));
    const going = (id: string, userId: string) =>
      limits.db.query(
        `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at)
         VALUES ($1, $1, $2, 'p', 'running', now())`,
        [id, userId],
      );
    await going('anothers-orgless', ANOTHER_USER_ID);
    asked.length = 0;
    const orglessRun = (runId: string, prefix: string) =>
      http()
        .post('/api/runs')
        .send({ run_id: runId, plan: { id: 'orgless', nodes: planSteps(prefix) } });

    const orgless = await orglessRun('no-workspace', 'n');

    expect(orgless.status).toBe(422);
    expect(hitsUnder('n')).toBe(3);
    expect(await runRow(limits.db, 'no-workspace')).toMatchObject({
      limits: { 'run.steps': 3, 'run.loop_rounds': null, 'run.active_seconds': null },
    });
    expect(
      (await limits.db.query(`SELECT org_id FROM runtime_runs WHERE run_id = 'no-workspace'`)).rows,
    ).toEqual([{ org_id: null }]);
    await going('own-orgless', MOCK_USER_ID);
    const full = await orglessRun('no-room', 'full');
    expect(full.status).toBe(429);
    expect(full.body).toMatchObject({
      code: 'workspace_run_limit',
      limit: 'workspace.unfinished_runs',
      max: 1,
    });
    expect(hitsUnder('full')).toBe(0);
    expect(asked).toEqual([...METRICS, ...METRICS].map((metric) => ({ orgId: null, metric })));
  }, 60_000);
});
