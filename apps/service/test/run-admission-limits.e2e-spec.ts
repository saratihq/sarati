import { createHmac } from 'node:crypto';

import { Client } from 'pg';
import request from 'supertest';

import { RUN_ADMISSION_LOCK_SPACE } from '../src/database/advisory-lock-spaces';
import { TriggersService } from '../src/triggers/triggers.service';
import { ir, irNode } from './support/golden-docs';
import {
  bootLimitsApp,
  callStep,
  chain,
  edgeOn,
  HitFixture,
  type LimitsApp,
  MOCK_USER_ID,
  until,
} from './support/limits-fixture';
import { seedPlatformKeyEverywhere } from './support/platform-keys';

const MAX_RUNNING = 2;
const MAX_UNFINISHED = 3;
const RUNNING_FULL = `This workspace already has ${MAX_RUNNING} runs running, the most it may run at once. Try again when one finishes; an operator can raise WORKSPACE_MAX_RUNNING_RUNS.`;
const COMPOSIO_SECRET = 'whsec_e2e_run_limits';
const UNFINISHED_FULL = `This workspace already has ${MAX_UNFINISHED} unfinished runs — running, or waiting on an approval or a timer — the most it may hold at once. Finish or cancel some, then try again; an operator can raise WORKSPACE_MAX_UNFINISHED_RUNS.`;

/** A workspace's runs in flight, counted as each is admitted: past either cap a run is refused 429, recording nothing (in process, DBOS on, mock auth). */
describe('run limits: a workspace’s runs in flight (e2e, DBOS on)', () => {
  const fixture = new HitFixture();
  let limits: LimitsApp;
  let otherOrg = '';
  let personal = '';
  const http = () => request(limits.app.getHttpServer());
  const pending: Array<Promise<unknown>> = [];

  const send = (runId: string, nodes: unknown[], edges: unknown[], org?: string) => {
    let req = http().post('/api/runs/from-ir');
    if (org) req = req.set('X-Org-Id', org);
    return req.send({ run_id: runId, workflow_ir: ir(nodes, edges) }).then((res) => res);
  };

  /** A run held at its one step until `/<runId>` is released; resolves once it is in that step. */
  const held = async (runId: string, org?: string): Promise<void> => {
    fixture.hold(`/${runId}`);
    pending.push(send(runId, [callStep(fixture.base, runId)], [], org));
    await fixture.untilHit(`/${runId}`);
  };

  /** A run parked on an approval named after it; resolves once it waits. */
  const parked = async (runId: string, then?: string): Promise<void> => {
    const nodes = [
      irNode('approval', 'orchestr:wait_for_event', { topic: runId, timeout_ms: 600_000 }),
      ...(then ? [callStep(fixture.base, then)] : []),
    ];
    pending.push(send(runId, nodes, then ? chain(['approval', then]) : []));
    await until(async () => (await status(runId)) === 'waiting', `${runId} parked`);
  };

  /** A running run nothing runs, holding one of the personal workspace's slots until it is freed or the test ends. */
  const slotHeld = (name: string) =>
    limits.db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, org_id)
       VALUES ($1, $1, $2, 'p', 'running', now(), $3)`,
      [`slot-${name}`, MOCK_USER_ID, personal],
    );
  const freeSlot = (name: string) =>
    limits.db.query(`DELETE FROM runtime_runs WHERE id = $1`, [`slot-${name}`]);

  const status = async (runId: string): Promise<string | undefined> =>
    (await limits.db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE run_id = $1`, [runId]))
      .rows[0]?.status;

  const approve = (runId: string) =>
    http().post(`/api/runs/${runId}/events`).send({ topic: runId, payload: {} }).expect(200);

  /** Ends every run still held or parked, so the next test starts with an empty workspace. */
  const settleAll = async () => {
    const waiting = await limits.db.query<{ run_id: string; topic: string }>(
      `SELECT r.run_id, s.waiting_topic AS topic FROM runtime_runs r JOIN runtime_run_steps s ON s.run_id = r.id
        WHERE r.status = 'waiting' AND s.waiting_topic IS NOT NULL AND s.finished_at IS NULL`,
    );
    for (const w of waiting.rows) {
      await http().post(`/api/runs/${w.run_id}/events`).send({ topic: w.topic, payload: {} });
    }
    fixture.releaseAll();
    await Promise.allSettled(pending.splice(0));
    await limits.db.query(`DELETE FROM runtime_runs WHERE id LIKE 'slot-%'`);
  };

  const expectRefused = (res: request.Response, limit: string, max: number, detail: string) => {
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({ code: 'workspace_run_limit', limit, max, retry_after_s: 30, detail });
  };

  beforeAll(async () => {
    await fixture.listen();
    limits = await bootLimitsApp({
      WORKSPACE_MAX_RUNNING_RUNS: String(MAX_RUNNING),
      WORKSPACE_MAX_UNFINISHED_RUNS: String(MAX_UNFINISHED),
    });
    otherOrg = (await http().post('/api/orgs').send({ name: 'Other workspace' }).expect(201)).body
      .id as string;
    personal = (
      await limits.db.query<{ id: string }>(
        `SELECT id FROM organizations WHERE personal_owner_id IS NOT NULL`,
      )
    ).rows[0]!.id;
    await seedPlatformKeyEverywhere(limits.app, 'composio_api_key', 'ck_e2e_fake_key');
    await seedPlatformKeyEverywhere(limits.app, 'composio_webhook_secret', COMPOSIO_SECRET);
  }, 60_000);

  afterAll(async () => {
    await limits.close();
    await fixture.close();
  }, 60_000);

  afterEach(async () => {
    await settleAll();
    fixture.reset();
  }, 60_000);

  it('past WORKSPACE_MAX_RUNNING_RUNS a run is refused 429 with Retry-After and records nothing, while another workspace’s run is admitted', async () => {
    await held('r1');
    await held('r2');

    const refused = await send('r3', [callStep(fixture.base, 'r3')], []);

    expectRefused(refused, 'workspace.running_runs', MAX_RUNNING, RUNNING_FULL);
    expect(await status('r3')).toBeUndefined();
    expect(fixture.count('/r3')).toBe(0);
    await held('elsewhere', otherOrg);
    expect(await status('elsewhere')).toBe('running');
  }, 60_000);

  it('WORKSPACE_MAX_UNFINISHED_RUNS counts runs parked on an approval, which do not count as running', async () => {
    await parked('w1');
    await parked('w2');
    await held('t2r1');

    const refused = await send('t2r2', [callStep(fixture.base, 't2r2')], []);

    expectRefused(refused, 'workspace.unfinished_runs', MAX_UNFINISHED, UNFINISHED_FULL);
    expect(await status('t2r2')).toBeUndefined();
  }, 60_000);

  it('a run another run calls is never counted, nor refused at the cap', async () => {
    const child = await http()
      .post('/api/deploy')
      .send({
        workflow_json: ir(
          [
            irNode('trigger', 'orchestr:tool_trigger', {
              tool_name: 'held_child',
              description: 'holds a call',
              inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
            }),
            callStep(fixture.base, 'inchild'),
          ],
          [edgeOn('trigger', 'inchild')],
        ),
      })
      .expect(201);
    fixture.hold('/inchild');
    pending.push(
      send('caller', [irNode('call', 'orchestr:call_workflow', { workflow_id: child.body.workflow_id })], []),
    );
    await fixture.untilHit('/inchild');

    await held('beside');

    expect(await status('beside')).toBe('running');
    const tree = await limits.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE status = 'running'`,
    );
    expect(tree.rows[0]!.n).toBe(3);
  }, 60_000);

  it('a run with a lane in flight beside a parked one counts as running', async () => {
    fixture.hold('/lanebusy');
    pending.push(
      send(
        'two-lanes',
        [
          callStep(fixture.base, 'lanebusy'),
          irNode('gate', 'orchestr:wait_for_event', { topic: 'two-lanes-gate', timeout_ms: 600_000 }),
        ],
        [],
      ),
    );
    await fixture.untilHit('/lanebusy');
    await until(async () => (await status('two-lanes')) === 'waiting', 'two-lanes parked a lane');
    await slotHeld('t10');

    const refused = await send('t10r2', [callStep(fixture.base, 't10r2')], []);

    expectRefused(refused, 'workspace.running_runs', MAX_RUNNING, RUNNING_FULL);
    expect(await status('t10r2')).toBeUndefined();
    expect(fixture.count('/t10r2')).toBe(0);
  }, 60_000);

  it('two admissions racing for the workspace’s last slot each record their run, then count on its lock in turn, and exactly one is admitted', async () => {
    await held('first');
    const workspace = (
      await limits.db.query<{ id: string }>(
        `SELECT id FROM organizations WHERE personal_owner_id IS NOT NULL`,
      )
    ).rows[0]!.id;
    const side = new Client({ connectionString: process.env.DATABASE_URL });
    await side.connect();
    try {
      // Holds the workspace's admission lock, so both admissions are past their insert and wait to count.
      await side.query('BEGIN');
      await side.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [
        RUN_ADMISSION_LOCK_SPACE,
        workspace,
      ]);
      fixture.hold('/racer');
      const racers = ['racer-a', 'racer-b'].map((runId) =>
        send(runId, [callStep(fixture.base, 'racer')], []),
      );
      pending.push(...racers);
      const waiting = async () =>
        (
          await limits.db.query<{ locktype: string; classid: number | null }>(
            `SELECT l.locktype, l.classid::int AS classid
               FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE NOT l.granted AND a.datname = current_database()`,
          )
        ).rows;
      await until(
        async () => (await waiting()).length === 2,
        'both admissions waiting on the workspace lock',
      );

      expect(await waiting()).toEqual([
        { locktype: 'advisory', classid: RUN_ADMISSION_LOCK_SPACE },
        { locktype: 'advisory', classid: RUN_ADMISSION_LOCK_SPACE },
      ]);
      await side.query('COMMIT');
      // The admitted one is held at its step, so the first to answer is the one refused.
      expect((await Promise.race(racers)).status).toBe(429);
      await fixture.untilHit('/racer');
      expect([await status('racer-a'), await status('racer-b')].sort()).toEqual(['running', undefined]);
    } finally {
      await side.end();
    }
  }, 60_000);

  it('a resend of an id already holding a run is never refused for capacity, even while a resumed run has the workspace over its cap', async () => {
    await parked('resumes', 'resumed');
    fixture.hold('/resumed');
    await held('t5r1');
    await held('t5r2');
    await approve('resumes');
    await fixture.untilHit('/resumed');
    expect(await status('resumes')).toBe('running');

    // Started without waiting on the run, so the answer is the admission's alone, given while every run still holds its slot.
    const resent = await http()
      .post('/api/runs/async')
      .send({ run_id: 't5r1', workflow_ir: ir([callStep(fixture.base, 't5r1')], []) });

    expect(resent.status).toBe(201);
    expect(await status('resumes')).toBe('running');
    fixture.release('/t5r1');
    await until(async () => (await status('t5r1')) === 'completed', 't5r1 completed');
    expect(fixture.count('/t5r1')).toBe(1);
  }, 60_000);

  it('a refusal frees its Idempotency-Key, so the retry once a slot frees runs', async () => {
    await held('t6r1');
    await held('t6r2');
    const keyed = () =>
      http()
        .post('/api/runs/from-ir')
        .set('Idempotency-Key', 'retry-after-full')
        .send({ run_id: 'keyed', workflow_ir: ir([callStep(fixture.base, 'keyed')], []) });

    expect((await keyed()).status).toBe(429);
    fixture.release('/t6r1');
    await until(async () => (await status('t6r1')) === 'completed', 'r1 completed');

    expect((await keyed()).status).toBe(201);
    expect(fixture.count('/keyed')).toBe(1);
  }, 60_000);

  it('a native environment webhook over its workspace’s running-run limit is answered 429 with Retry-After and starts nothing; its resend once a slot frees runs once', async () => {
    const hook = await http()
      .post('/api/deploy')
      .send({
        workflow_json: {
          ...ir(
            [irNode('trigger', 'orchestr:webhook', {}), callStep(fixture.base, 'hooked')],
            [edgeOn('trigger', 'hooked')],
          ),
          name: 'hooked',
        },
      })
      .expect(201);
    const workflowId = hook.body.workflow_id as string;
    await held('t7r1');
    await held('t7r2');

    const refused = await http().post(`/api/hooks/${workflowId}/production`).send({ n: 1 });

    expectRefused(refused, 'workspace.running_runs', MAX_RUNNING, RUNNING_FULL);
    const runs = () =>
      limits.db
        .query(`SELECT 1 FROM runtime_runs WHERE workflow_id = $1`, [workflowId])
        .then((r) => r.rowCount);
    expect(await runs()).toBe(0);

    fixture.release('/t7r1');
    await until(async () => (await status('t7r1')) === 'completed', 'r1 completed');
    expect((await http().post(`/api/hooks/${workflowId}/production`).send({ n: 1 })).status).toBe(202);
    await fixture.untilHit('/hooked');
    expect(await runs()).toBe(1);
  }, 60_000);

  it('a branch test a side of which the running-run limit refuses keeps no result and leaves the merge gate as it was', async () => {
    const doc = (msg: string) => ({
      ...ir(
        [
          irNode('trigger', 'orchestr:trigger', {}),
          irNode('code', 'orchestr:code', { language: 'js', code: `return { msg: '${msg}' };` }),
        ],
        [edgeOn('trigger', 'code')],
      ),
      name: 'branch tested',
    });
    const wf = (
      await http()
        .post('/api/deploy')
        .send({ workflow_json: doc('base') })
        .expect(201)
    ).body.workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'change' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: doc('changed'), branch: 'change' })
      .expect(201);
    const review = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'change', title: 'Change' })
        .expect(201)
    ).body.id as string;
    await held('t9r1');
    await held('t9r2');

    const tested = await http().post(`/api/workflows/${wf}/reviews/${review}/test`).send({});

    expectRefused(tested, 'workspace.running_runs', MAX_RUNNING, RUNNING_FULL);
    const kept = await limits.db.query(`SELECT 1 FROM review_test_results WHERE review_id = $1`, [review]);
    expect(kept.rowCount).toBe(0);
    const runs = await limits.db.query(`SELECT 1 FROM runtime_runs WHERE review_id = $1`, [review]);
    expect(runs.rowCount).toBe(0);
  }, 60_000);

  it('a branch test with one slot left admits neither side: it is refused 429 and records no run, and neither side calls anything', async () => {
    const doc = (side: string) => ({
      ...ir(
        [irNode('trigger', 'orchestr:trigger', {}), callStep(fixture.base, side)],
        [edgeOn('trigger', side)],
      ),
      name: 'one slot left',
    });
    const wf = (
      await http()
        .post('/api/deploy')
        .send({ workflow_json: doc('sidebase') })
        .expect(201)
    ).body.workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'change' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: doc('sidehead'), branch: 'change' })
      .expect(201);
    const review = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'change', title: 'Change' })
        .expect(201)
    ).body.id as string;
    fixture.hold('/sidebase');
    fixture.hold('/sidehead');
    await slotHeld('t11');

    const tested = await http().post(`/api/workflows/${wf}/reviews/${review}/test`).send({});

    expectRefused(tested, 'workspace.running_runs', MAX_RUNNING, RUNNING_FULL);
    const runs = await limits.db.query(`SELECT 1 FROM runtime_runs WHERE review_id = $1`, [review]);
    expect(runs.rowCount).toBe(0);
    expect({ base: fixture.count('/sidebase'), head: fixture.count('/sidehead') }).toEqual({
      base: 0,
      head: 0,
    });
    const kept = await limits.db.query(`SELECT 1 FROM review_test_results WHERE review_id = $1`, [review]);
    expect(kept.rowCount).toBe(0);
  }, 60_000);

  it('a Composio delivery one holder’s workspace has no room for still admits every other holder’s run, records the refusal on that activation, and its resend admits the refused one exactly once', async () => {
    const instance = 'ti_e2e_run_limits';
    const doc = {
      ...ir(
        [
          { ...irNode('trigger', 'github.github_commit_event', {}), metadata: { trigger: true } },
          irNode('say', 'text.concat', { texts: ['fired'], separator: '' }),
        ],
        [edgeOn('trigger', 'say')],
      ),
      name: 'composio holder',
    };
    const deploy = async (org?: string): Promise<string> => {
      let req = http().post('/api/deploy');
      if (org) req = req.set('X-Org-Id', org);
      return (await req.send({ workflow_json: doc }).expect(201)).body.workflow_id as string;
    };
    // The full workspace's holder first, as the delivery reads them.
    const full = await deploy();
    const roomy = await deploy(otherOrg);
    const activationOf = async (workflowId: string): Promise<string> =>
      (
        await limits.db.query<{ id: string }>(
          `UPDATE runtime_trigger_activations
              SET composio_trigger_instance_id = $2, connection_owner_user_id = $3,
                  connection_id = gen_random_uuid(), held = false, last_error = NULL
            WHERE workflow_id = $1 AND kind = 'composio_subscription' RETURNING id`,
          [workflowId, instance, MOCK_USER_ID],
        )
      ).rows[0]!.id;
    const fullActivation = await activationOf(full);
    await activationOf(roomy);
    const deliver = () => {
      const raw = JSON.stringify({ metadata: { trigger_id: instance }, data: { action: 'push' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const signature =
        'v1,' + createHmac('sha256', COMPOSIO_SECRET).update(`msg_run_limits.${ts}.${raw}`).digest('base64');
      return http()
        .post('/api/hooks/composio')
        .set('Content-Type', 'application/json')
        .set('webhook-id', 'msg_run_limits')
        .set('webhook-timestamp', ts)
        .set('webhook-signature', signature)
        .send(raw);
    };
    const runsOf = async (workflowId: string): Promise<string[]> =>
      (
        await limits.db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE workflow_id = $1`, [
          workflowId,
        ])
      ).rows.map((r) => r.status);
    try {
      await slotHeld('t12a');
      await slotHeld('t12b');

      const refused = await deliver();

      expectRefused(refused, 'workspace.running_runs', MAX_RUNNING, RUNNING_FULL);
      expect(await runsOf(full)).toEqual([]);
      await until(
        async () => (await runsOf(roomy)).join() === 'completed',
        'the roomy holder’s run completed',
      );
      const lastError = await limits.db.query<{ last_error: string | null }>(
        `SELECT last_error FROM runtime_trigger_activations WHERE id = $1`,
        [fullActivation],
      );
      expect(lastError.rows[0]!.last_error).toBe(RUNNING_FULL);

      await freeSlot('t12a');
      const resent = await deliver();

      expect(resent.status).toBe(202);
      await until(
        async () => (await runsOf(full)).join() === 'completed',
        'the refused holder’s run completed',
      );
      expect(await runsOf(roomy)).toEqual(['completed']);
      const cleared = await limits.db.query<{ last_error: string | null }>(
        `SELECT last_error FROM runtime_trigger_activations WHERE id = $1`,
        [fullActivation],
      );
      expect(cleared.rows[0]!.last_error).toBeNull();
      expect((await deliver()).body).toMatchObject({ duplicate: true });
    } finally {
      // Its subscriptions gone, so no later poll's orphan sweep asks Composio about them.
      await limits.db.query(`DELETE FROM runtime_trigger_activations WHERE workflow_id IN ($1, $2)`, [
        full,
        roomy,
      ]);
    }
  }, 60_000);

  it('a schedule tick over the limit keeps its cursor and records why on its activation, and the next poll admits that tick exactly once', async () => {
    const scheduled = await http()
      .post('/api/deploy')
      .send({
        workflow_json: {
          ...ir(
            [
              irNode('trigger', 'orchestr:schedule', { interval_minutes: 60 }),
              callStep(fixture.base, 'ticked'),
            ],
            [edgeOn('trigger', 'ticked')],
          ),
          name: 'scheduled',
        },
      })
      .expect(201);
    const workflowId = scheduled.body.workflow_id as string;
    const activation = (
      await limits.db.query<{ id: string }>(
        `SELECT id FROM runtime_trigger_activations WHERE workflow_id = $1`,
        [workflowId],
      )
    ).rows[0]!.id;
    const lastFire = new Date(Date.now() - 61 * 60_000).toISOString();
    await limits.db.query(
      `UPDATE runtime_activation_store SET value = to_json($2::text) WHERE activation_id = $1 AND key = 'schedule.lastFire'`,
      [activation, lastFire],
    );
    const cursor = async () =>
      (
        await limits.db.query<{ value: unknown }>(
          `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = 'schedule.lastFire'`,
          [activation],
        )
      ).rows[0]?.value;
    const runs = () =>
      limits.db
        .query(`SELECT 1 FROM runtime_runs WHERE workflow_id = $1`, [workflowId])
        .then((r) => r.rowCount);
    await held('t8r1');
    await held('t8r2');

    await limits.app.get(TriggersService).runActivationPollCycle();

    expect(await runs()).toBe(0);
    expect(await cursor()).toBe(lastFire);
    const lastError = await limits.db.query<{ last_error: string }>(
      `SELECT last_error FROM runtime_trigger_activations WHERE id = $1`,
      [activation],
    );
    expect(lastError.rows[0]!.last_error).toContain(RUNNING_FULL);

    fixture.release('/t8r1');
    await until(async () => (await status('t8r1')) === 'completed', 'r1 completed');
    await limits.app.get(TriggersService).runActivationPollCycle();
    await fixture.untilHit('/ticked');
    await limits.app.get(TriggersService).runActivationPollCycle();
    expect(await runs()).toBe(1);
    expect(await cursor()).not.toBe(lastFire);
  }, 60_000);
});
