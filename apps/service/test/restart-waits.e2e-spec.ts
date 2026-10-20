import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

import { Client } from 'pg';

import { NOT_RESUMABLE } from '../src/dbos/recovery-guard';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;

interface Parked {
  step_key: string;
  waiting_since: Date;
  waiting_timeout_at: Date;
}

/** The real service in its own process, killed with SIGKILL and booted again on the same database (DBOS on). */
describe('waits across a crash and a reboot (e2e, child process, DBOS on, mock auth)', () => {
  let db: Client;
  let dbos: Client;
  let databaseUrl: string;
  let port: number;
  let service: ChildProcess | undefined;
  let log = '';

  const url = (path: string): string => `http://127.0.0.1:${port}${path}`;
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const json = async (path: string): Promise<Record<string, unknown>> =>
    (await (await fetch(url(path))).json()) as Record<string, unknown>;

  async function eventually<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const value = await read().catch(() => undefined);
      if (value !== undefined && done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}\n${log.slice(-4_000)}`);
  }

  async function boot(env: Record<string, string> = {}): Promise<void> {
    log = '';
    service = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/main.ts'], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DBOS_SYSTEM_DATABASE_URL: '',
        PORT: String(port),
        MOCK_AUTH: 'true',
        PGBOSS_ENABLED: 'false',
        DBOS_ENABLED: 'true',
        THROTTLE_LIMIT: '10000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    service.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    await eventually(
      () => fetch(url('/api/health')),
      (res) => res.ok,
      'the service answering',
    );
  }

  async function crash(): Promise<void> {
    const dead = new Promise((r) => service!.once('exit', r));
    service!.kill('SIGKILL');
    await dead;
  }

  const parkedIn = async (runId: string): Promise<Parked[]> =>
    (
      await db.query<Parked>(
        `SELECT s.step_key, s.waiting_since, s.waiting_timeout_at FROM runtime_run_steps s
          WHERE s.run_id = $1 AND s.waiting_topic IS NOT NULL ORDER BY s.step_key`,
        [`${MOCK_USER_ID}:${runId}`],
      )
    ).rows;

  const recoveries = async (runIds: string[]): Promise<number[]> =>
    (
      await dbos.query<{ recovery_attempts: string }>(
        `SELECT recovery_attempts FROM dbos.workflow_status WHERE workflow_uuid = ANY($1) ORDER BY workflow_uuid`,
        [runIds.map((id) => `${MOCK_USER_ID}:${id}`)],
      )
    ).rows.map((r) => Number(r.recovery_attempts));

  const completed = (runId: string): Promise<Record<string, unknown>> =>
    eventually(
      () => json(`/api/runs/${runId}`),
      (d) => d.status === 'completed',
      `${runId} completed`,
    );

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    await boot();
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    dbos = new Client({ connectionString: sysUrl.toString() });
    await dbos.connect();
  }, 90_000);

  afterAll(async () => {
    if (service && service.exitCode === null) await crash();
    await dbos?.end();
    await db.end();
  }, 30_000);

  it('keeps a pending wait and its deadline, never parks an answered one again, and stays up', async () => {
    const start = (runId: string, nodes: unknown[]) =>
      post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } });
    const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
    expect((await start('pending', [approval('approve')])).status).toBe(201);
    expect((await start('sequence', [approval('first'), approval('second')])).status).toBe(201);

    await eventually(
      () => parkedIn('pending'),
      (p) => p.length === 1,
      'pending parked',
    );
    await eventually(
      () => parkedIn('sequence'),
      (p) => p[0]?.step_key === 'first',
      'first parked',
    );
    expect(
      (await post('/api/runs/sequence/events', { topic: 'approval', payload: { decision: 'one' } })).status,
    ).toBe(200);
    const before = {
      pending: await parkedIn('pending'),
      sequence: await eventually(
        () => parkedIn('sequence'),
        (p) => p[0]?.step_key === 'second',
        'second parked',
      ),
    };
    const attempts = await recoveries(['pending', 'sequence']);

    await crash();
    await boot();
    await eventually(
      () => recoveries(['pending', 'sequence']),
      (now) => now.every((n, i) => n > attempts[i]!),
      'both runs recovered',
    );

    const listed = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const inbox = (await json('/api/runs/waiting')).runs as Array<{ run_id: string; step_key: string }>;
      for (const row of inbox) listed.add(`${row.run_id}/${row.step_key}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect([...listed].sort()).toEqual(['pending/approve', 'sequence/second']);
    expect(await parkedIn('pending')).toEqual(before.pending);
    expect(await parkedIn('sequence')).toEqual(before.sequence);

    expect(
      (await post('/api/runs/pending/events', { topic: 'approval', payload: { decision: 'yes' } })).status,
    ).toBe(200);
    expect(
      (await post('/api/runs/sequence/events', { topic: 'approval', payload: { decision: 'two' } })).status,
    ).toBe(200);
    expect((await completed('pending')).outputs).toMatchObject({ approve: { decision: 'yes' } });
    expect((await completed('sequence')).outputs).toMatchObject({
      first: { decision: 'one' },
      second: { decision: 'two' },
    });
    expect(service!.exitCode).toBeNull();
    expect((await fetch(url('/api/health'))).ok).toBe(true);
  }, 120_000);

  it('keeps when a wait ended across a crash and its replay, so recovery never restarts the run’s time in flight', async () => {
    const runKey = `${MOCK_USER_ID}:clock`;
    const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
    const first = async (): Promise<{ resumed_at: string | null; finished_at: string | null }> =>
      (
        await db.query(
          `SELECT resumed_at::text, finished_at::text FROM runtime_run_steps WHERE run_id = $1 AND step_key = 'first'`,
          [runKey],
        )
      ).rows[0];
    expect(
      (
        await post('/api/runs/async', {
          run_id: 'clock',
          plan: { id: 'plan-clock', nodes: [approval('first'), approval('second')] },
        })
      ).status,
    ).toBe(201);
    await eventually(
      () => parkedIn('clock'),
      (p) => p[0]?.step_key === 'first',
      'first parked',
    );
    expect((await post('/api/runs/clock/events', { topic: 'approval', payload: { d: 'one' } })).status).toBe(
      200,
    );
    await eventually(
      () => parkedIn('clock'),
      (p) => p[0]?.step_key === 'second',
      'second parked',
    );
    const before = await first();
    expect(before.resumed_at).not.toBeNull();
    const attempts = await recoveries(['clock']);

    await crash();
    await boot();
    await eventually(
      () => recoveries(['clock']),
      (now) => now[0]! > attempts[0]!,
      'clock recovered',
    );
    await eventually(
      first,
      (row) => row.finished_at !== null && row.finished_at !== before.finished_at,
      'first finished on replay',
    );
    expect((await first()).resumed_at).toBe(before.resumed_at);

    expect((await post('/api/runs/clock/events', { topic: 'approval', payload: { d: 'two' } })).status).toBe(
      200,
    );
    expect((await completed('clock')).outputs).toMatchObject({ first: { d: 'one' }, second: { d: 'two' } });
  }, 120_000);

  it('never lists or takes a decision for a wait that resumed just before the crash, while its replay is held', async () => {
    const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
    const runKey = `${MOCK_USER_ID}:replayed`;
    expect(
      (
        await post('/api/runs/async', {
          run_id: 'replayed',
          plan: { id: 'plan-replayed', nodes: [approval('first'), approval('second')] },
        })
      ).status,
    ).toBe(201);
    await eventually(
      () => parkedIn('replayed'),
      (p) => p[0]?.step_key === 'first',
      'first parked',
    );
    expect(
      (
        await post('/api/runs/replayed/events', {
          topic: 'approval',
          step_key: 'first',
          payload: { d: 'one' },
        })
      ).status,
    ).toBe(200);
    await eventually(
      () => parkedIn('replayed'),
      (p) => p[0]?.step_key === 'second',
      'second parked',
    );

    await crash();
    await db.query(
      `UPDATE runtime_run_steps SET status = 'running', finished_at = NULL, output = NULL
        WHERE run_id = $1 AND step_key = 'first'`,
      [runKey],
    );
    // Holding DBOS's recorded outputs back keeps the replay parked inside first's recv.
    await dbos.query('BEGIN');
    await dbos.query('LOCK TABLE dbos.operation_outputs IN ACCESS EXCLUSIVE MODE');
    try {
      await boot();
      await eventually(
        () =>
          dbos.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND relation = 'dbos.operation_outputs'::regclass`,
          ),
        (res) => Number(res.rows[0]!.n) > 0,
        'the replay held at its recorded recv',
      );
      await new Promise((r) => setTimeout(r, 1_000));

      const inbox = (await json('/api/runs/waiting')).runs as Array<{ run_id: string; step_key: string }>;
      expect(inbox.filter((r) => r.run_id === 'replayed').map((r) => r.step_key)).toEqual(['second']);
      const stray = await post('/api/runs/replayed/events', {
        topic: 'approval',
        step_key: 'first',
        payload: { d: 'stray' },
      });
      expect(stray.status).toBe(409);
      expect(await parkedIn('replayed')).toEqual([expect.objectContaining({ step_key: 'second' })]);
    } finally {
      await dbos.query('ROLLBACK');
    }

    await eventually(
      () =>
        db.query(`SELECT finished_at FROM runtime_run_steps WHERE run_id = $1 AND step_key = 'first'`, [
          runKey,
        ]),
      (res) => res.rows[0]?.finished_at !== null,
      'first finished on replay',
    );
    expect(
      (
        await post('/api/runs/replayed/events', {
          topic: 'approval',
          step_key: 'second',
          payload: { d: 'two' },
        })
      ).status,
    ).toBe(200);
    expect((await completed('replayed')).outputs).toMatchObject({
      first: { d: 'one' },
      second: { d: 'two' },
    });
  }, 120_000);

  it('sends a decision claimed just before a crash again as soon as the service is back, crediting who made it', async () => {
    const approval = { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: WINDOW_MS };
    expect(
      (await post('/api/runs/async', { run_id: 'claimed', plan: { id: 'plan-claimed', nodes: [approval] } }))
        .status,
    ).toBe(201);
    await eventually(
      () => parkedIn('claimed'),
      (p) => p.length === 1,
      'claimed parked',
    );

    // The claim commits; its send is held at the notifications table until the process is gone.
    await dbos.query('BEGIN');
    await dbos.query('LOCK TABLE dbos.notifications IN EXCLUSIVE MODE');
    let sent: Promise<Response | null> = Promise.resolve(null);
    try {
      sent = post('/api/runs/claimed/events', {
        topic: 'approval',
        payload: { d: 'before the crash' },
      }).catch(() => null);
      await eventually(
        () =>
          dbos.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND relation = 'dbos.notifications'::regclass`,
          ),
        (res) => Number(res.rows[0]!.n) > 0,
        'the send held',
      );
      await crash();
      await dbos.query(
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE NOT l.granted AND l.relation = 'dbos.notifications'::regclass`,
      );
    } finally {
      await dbos.query('ROLLBACK');
    }
    await sent;
    expect(
      (
        await dbos.query(`SELECT 1 FROM dbos.notifications WHERE destination_uuid = $1`, [
          `${MOCK_USER_ID}:claimed`,
        ])
      ).rows,
    ).toEqual([]);

    await boot();
    const bootedAt = Date.now();
    expect((await completed('claimed')).outputs).toMatchObject({ approve: { d: 'before the crash' } });
    // Sent at boot, well inside the resender's own 30s interval.
    expect(Date.now() - bootedAt).toBeLessThan(10_000);
    expect((await json('/api/runs/claimed')).decided_by).toMatchObject({ id: MOCK_USER_ID });
  }, 120_000);

  const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
  const fork = { kind: 'parallel', id: 'fork', branches: [[approval('a1')], [approval('a2')]] };

  /** A run from before waits were told apart, recovered before its fork: its two parallel waits share one receive. */
  async function sharedReceiveRun(runId: string): Promise<string> {
    const runKey = `${MOCK_USER_ID}:${runId}`;
    const gate = { kind: 'waitForEvent', id: 'gate', topic: 'gate', timeoutMs: WINDOW_MS };
    expect(
      (await post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes: [gate, fork] } }))
        .status,
    ).toBe(201);
    await eventually(
      () => parkedIn(runId),
      (p) => p.length === 1,
      `${runId} parked at its gate`,
    );
    await crash();
    const rewritten = await dbos.query(
      `UPDATE dbos.workflow_status SET inputs = replace(inputs, '"sharedTopicsByStep":true', '"sharedTopicsByStep":false')
        WHERE workflow_uuid = $1 AND inputs LIKE '%"sharedTopicsByStep":true%'`,
      [runKey],
    );
    expect(rewritten.rowCount).toBe(1);
    await boot();
    expect((await post(`/api/runs/${runId}/events`, { topic: 'gate', payload: { d: 'go' } })).status).toBe(
      200,
    );
    await eventually(
      () =>
        db.query<{ step_key: string }>(
          `SELECT step_key FROM runtime_run_steps
            WHERE run_id = $1 AND waiting_topic = 'approval' AND finished_at IS NULL AND delivery_topic IS NULL`,
          [runKey],
        ),
      (res) => res.rows.length === 2,
      `both ${runId} waits parked on the topic itself`,
    );
    return runKey;
  }

  const decide = (runId: string, d: string): Promise<Response> =>
    post(`/api/runs/${runId}/events`, { topic: 'approval', payload: { d } });

  const waitOutputs = async (runId: string): Promise<unknown[]> => {
    const outputs = (await completed(runId)).outputs as Record<string, unknown>;
    return [outputs.a1, outputs.a2];
  };

  it('lists the parallel waits of a run from before waits were told apart once, and a decision sent by topic is taken by exactly one of them', async () => {
    const runKey = await sharedReceiveRun('legacy');
    const rows = ((await json('/api/runs/waiting')).runs as Array<Record<string, unknown>>).filter(
      (r) => r.run_id === 'legacy',
    );
    expect(rows).toEqual([
      expect.objectContaining({ step_key: null, node_id: null, waits: 2, topic: 'approval' }),
    ]);

    const aimed = await post('/api/runs/legacy/events', {
      topic: 'approval',
      step_key: 'fork|0/a1',
      payload: { d: 'x' },
    });
    expect(aimed.status).toBe(409);
    expect(((await aimed.json()) as { detail: string }).detail).toBe(
      'Step "fork|0/a1" of run legacy shares one receive with another wait on "approval" — the run started ' +
        'before waits were told apart, so send the decision with the topic only',
    );

    const decided = await decide('legacy', 'x');
    expect(decided.status).toBe(200);
    expect(await decided.json()).toEqual({ status: 'sent', step_key: null });
    await eventually(
      () =>
        db.query(`SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND finished_at IS NOT NULL`, [runKey]),
      (res) => res.rows.length >= 1,
      'a wait took the decision',
    );
    // Both receives wake on it: the other ends with none if it looked before the first one's take committed, else it
    // goes on waiting. Ending with none takes it milliseconds, so one still parked after this is parked.
    await new Promise((r) => setTimeout(r, 5_000));
    const detail = await json('/api/runs/legacy');
    const steps = (
      detail.steps as Array<{
        step_key: string;
        output: unknown;
        finished_at: string | null;
        decided_by: unknown;
      }>
    ).filter((s) => s.step_key !== 'gate');
    const takers = steps.filter((s) => JSON.stringify(s.output) === JSON.stringify({ d: 'x' }));
    expect(takers).toHaveLength(1);
    expect(takers[0]!.decided_by).toMatchObject({ id: MOCK_USER_ID });
    const other = steps.find((s) => JSON.stringify(s.output) !== JSON.stringify({ d: 'x' }))!;
    expect(other.decided_by).toBeNull();
    if (detail.status === 'completed') {
      expect(other).toMatchObject({ output: null, finished_at: expect.any(String) });
    } else {
      // The shared receive was decided once for both waits, so a second decision is refused.
      expect(other.finished_at).toBeNull();
      const again = await decide('legacy', 'y');
      expect(again.status).toBe(409);
      expect(((await again.json()) as { detail: string }).detail).toBe(
        'Every wait of run legacy on topic "approval" is already decided',
      );
    }
    expect(detail.decided_by).toMatchObject({ id: MOCK_USER_ID });
  }, 120_000);

  it('ends the other parallel wait of a run from before waits were told apart with none when it sees the decision before it is taken', async () => {
    const runKey = await sharedReceiveRun('held-take');
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    const holder = new Client({ connectionString: sysUrl.toString() });
    await holder.connect();
    try {
      // The first take cannot commit, so the other receive finds the decision still there and queues on its row.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE dbos.operation_outputs IN EXCLUSIVE MODE');
      expect((await decide('held-take', 'x')).status).toBe(200);
      await eventually(
        () =>
          dbos.query<{ query: string }>(
            `SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          ),
        (res) =>
          res.rows.some((r) => /INSERT INTO\s+"?dbos"?\.operation_outputs/i.test(r.query)) &&
          res.rows.some((r) => /UPDATE\s+"?dbos"?\.notifications/i.test(r.query)),
        'the take and the other receive both held',
      );
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect((await waitOutputs('held-take')).sort()).toEqual([null, { d: 'x' }].sort());
    const credits = await db.query<{ output: unknown; decided_by: string | null }>(
      `SELECT output, decided_by FROM runtime_run_steps WHERE run_id = $1 AND step_key LIKE 'fork|%'`,
      [runKey],
    );
    expect(credits.rows).toHaveLength(2);
    expect(credits.rows).toEqual(
      expect.arrayContaining([
        { output: { d: 'x' }, decided_by: MOCK_USER_ID },
        { output: null, decided_by: null },
      ]),
    );
    const kept = await db.query(`SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND finished_at IS NULL`, [
      runKey,
    ]);
    expect(kept.rows).toEqual([]);
  }, 120_000);

  it('ends in error a run whose parallel waits were parked when it stopped, instead of parking them again', async () => {
    const runKey = `${MOCK_USER_ID}:parked-fork`;
    expect(
      (
        await post('/api/runs/async', {
          run_id: 'parked-fork',
          plan: { id: 'plan-parked-fork', nodes: [fork] },
        })
      ).status,
    ).toBe(201);
    await eventually(
      () => parkedIn('parked-fork'),
      (p) => p.length === 2,
      'both parked-fork waits parked',
    );
    await crash();
    await boot();
    const ended = await eventually(
      () =>
        db.query<{ status: string; error: string | null }>(
          `SELECT status, error FROM runtime_runs WHERE id = $1`,
          [runKey],
        ),
      (res) => res.rows[0]?.status === 'error',
      'parked-fork ended',
    );
    expect(ended.rows).toEqual([{ status: 'error', error: NOT_RESUMABLE['side-by-side'] }]);
    expect(await parkedIn('parked-fork')).toEqual([]);
    const listed = (await json('/api/runs/waiting')).runs as Array<Record<string, unknown>>;
    expect(listed.filter((r) => r.run_id === 'parked-fork')).toEqual([]);
  }, 120_000);

  it('never sends a decision again once its wait has given up, so the next wait on the topic is still a person’s', async () => {
    const runKey = `${MOCK_USER_ID}:late-claim`;
    const nodes = [
      { kind: 'waitForEvent', id: 'first', topic: 'approval', timeoutMs: 6_000 },
      { kind: 'waitForEvent', id: 'second', topic: 'approval', timeoutMs: WINDOW_MS },
    ];
    expect(
      (await post('/api/runs/async', { run_id: 'late-claim', plan: { id: 'plan-late-claim', nodes } }))
        .status,
    ).toBe(201);
    await eventually(
      () => parkedIn('late-claim'),
      (p) => p[0]?.step_key === 'first',
      'first parked',
    );

    await dbos.query('BEGIN');
    await dbos.query('LOCK TABLE dbos.notifications IN EXCLUSIVE MODE');
    let sent: Promise<Response | null> = Promise.resolve(null);
    try {
      sent = post('/api/runs/late-claim/events', { topic: 'approval', payload: { d: 'first' } }).catch(
        () => null,
      );
      await eventually(
        () =>
          dbos.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND relation = 'dbos.notifications'::regclass`,
          ),
        (res) => Number(res.rows[0]!.n) > 0,
        'the send held',
      );
      await crash();
      await dbos.query(
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE NOT l.granted AND l.relation = 'dbos.notifications'::regclass`,
      );
    } finally {
      await dbos.query('ROLLBACK');
    }
    await sent;
    await new Promise((r) => setTimeout(r, 7_000));

    await boot();
    await eventually(
      () => parkedIn('late-claim'),
      (p) => p[0]?.step_key === 'second',
      'second parked',
    );
    const listed = ((await json('/api/runs/waiting')).runs as Array<Record<string, unknown>>).filter(
      (r) => r.run_id === 'late-claim',
    );
    expect(listed).toEqual([expect.objectContaining({ step_key: 'second' })]);
    expect(
      (await dbos.query(`SELECT 1 FROM dbos.notifications WHERE destination_uuid = $1`, [runKey])).rows,
    ).toEqual([]);

    expect(
      (await post('/api/runs/late-claim/events', { topic: 'approval', payload: { d: 'second' } })).status,
    ).toBe(200);
    expect((await completed('late-claim')).outputs).toMatchObject({ first: null, second: { d: 'second' } });
  }, 120_000);

  it('ends in error a run recovered after an error lane finished beside another branch, running nothing again', async () => {
    const hits = new Map<string, number>();
    const fixture = createHttpServer((req, res) => {
      hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const get = (id: string) => ({
      kind: 'action',
      id,
      actionId: 'http.send_request',
      props: { method: 'GET', url: `${base}/${id}` },
    });
    const runKey = `${MOCK_USER_ID}:lane-beside`;
    try {
      const boom = {
        kind: 'code',
        id: 'boom',
        language: 'js',
        code: 'throw new Error("boom failed");',
        onErrorBranch: [get('handled')],
      };
      const fork = {
        kind: 'parallel',
        id: 'fork',
        branches: [[boom], [get('first'), { kind: 'delay', id: 'nap', ms: 20_000 }, get('after')]],
      };
      const nodes = [fork, get('tail')];
      expect(
        (await post('/api/runs/async', { run_id: 'lane-beside', plan: { id: 'plan-lane-beside', nodes } }))
          .status,
      ).toBe(201);
      await eventually(
        () =>
          db.query(
            `SELECT 1 FROM runtime_run_steps
              WHERE run_id = $1 AND (step_key = 'fork|1/nap' OR (step_key = 'fork|0/handled' AND finished_at IS NOT NULL))`,
            [runKey],
          ),
        (res) => res.rows.length === 2,
        'the lane finished, its sibling napping',
      );
      await crash();
      await boot();
      const run = await eventually(
        () =>
          db.query<{ status: string; error: string | null }>(
            `SELECT status, error FROM runtime_runs WHERE id = $1`,
            [runKey],
          ),
        (res) => res.rows[0]?.status !== 'running' && res.rows[0]?.status !== 'waiting',
        'the recovered run ended',
      );
      expect(run.rows).toEqual([{ status: 'error', error: NOT_RESUMABLE['side-by-side'] }]);
      const workflow = await eventually(
        () =>
          dbos.query<{ status: string }>(`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`, [
            runKey,
          ]),
        (res) => res.rows[0]?.status === 'ERROR' || res.rows[0]?.status === 'SUCCESS',
        'the recovered workflow ended',
      );
      expect(workflow.rows[0]!.status).toBe('ERROR');
      expect(Object.fromEntries(hits)).toEqual({ '/handled': 1, '/first': 1 });
    } finally {
      await new Promise((r) => fixture.close(r));
    }
  }, 120_000);

  it('ends in error a run whose recovery finds another op in a continue-on-fail step, running nothing after it', async () => {
    const hits = new Map<string, number>();
    const fixture = createHttpServer((req, res) => {
      hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const get = (id: string, extra: Record<string, unknown> = {}) => ({
      kind: 'action',
      id,
      actionId: 'http.send_request',
      props: { method: 'GET', url: `${base}/${id}` },
      ...extra,
    });
    const runKey = `${MOCK_USER_ID}:mismatched`;
    try {
      const nodes = [
        get('first', { onError: 'continue' }),
        { kind: 'delay', id: 'nap', ms: 20_000 },
        get('after'),
      ];
      expect(
        (await post('/api/runs/async', { run_id: 'mismatched', plan: { id: 'plan-mismatched', nodes } }))
          .status,
      ).toBe(201);
      await eventually(
        () => db.query(`SELECT 1 FROM runtime_run_steps WHERE run_id = $1 AND step_key = 'nap'`, [runKey]),
        (res) => res.rows.length === 1,
        'napping',
      );
      await crash();
      // A name the plan issues, in another step's slot: the guard admits it, and DBOS refuses it at the lookup.
      const moved = await dbos.query(
        `UPDATE dbos.operation_outputs SET function_name = 'plan-mismatched:after'
          WHERE workflow_uuid = $1 AND function_name = 'plan-mismatched:first'`,
        [runKey],
      );
      expect(moved.rowCount).toBe(1);

      await boot();
      const run = await eventually(
        () =>
          db.query<{ status: string; error: string | null }>(
            `SELECT status, error FROM runtime_runs WHERE id = $1`,
            [runKey],
          ),
        (res) => res.rows[0]?.status !== 'running' && res.rows[0]?.status !== 'waiting',
        'the recovered run ended',
      );
      expect(run.rows[0]!.status).toBe('error');
      expect(run.rows[0]!.error).toMatch(
        /plan-mismatched:after was recorded when plan-mismatched:first was expected/,
      );
      expect([hits.get('/first'), hits.get('/after')]).toEqual([1, undefined]);
    } finally {
      await new Promise((r) => fixture.close(r));
    }
  }, 120_000);

  it('leaves a run that ended while its workflow was down as it ended: recovery writes nothing to it and drops its file blobs', async () => {
    const ids = [`${MOCK_USER_ID}:finished`, `${MOCK_USER_ID}:reaped`];
    for (const runId of ['finished', 'reaped']) {
      const nodes = [{ kind: 'delay', id: 'nap', ms: 20_000 }];
      expect(
        (await post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } })).status,
      ).toBe(201);
    }
    await eventually(
      () => db.query(`SELECT 1 FROM runtime_run_steps WHERE run_id = ANY($1) AND step_key = 'nap'`, [ids]),
      (res) => res.rows.length === 2,
      'both napping',
    );
    const attempts = await recoveries(['finished', 'reaped']);
    await crash();
    await db.query(`UPDATE runtime_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [
      ids[0],
    ]);
    await db.query(
      `UPDATE runtime_runs SET status = 'error', error = 'Reaped while the service was down', finished_at = now()
        WHERE id = $1`,
      [ids[1]],
    );
    const history = async (): Promise<unknown[]> =>
      (
        await db.query(
          `SELECT r.id, r.status, r.error, r.outputs::text, r.finished_at::text, s.step_key, s.status AS step,
                  s.started_at::text AS step_started, s.finished_at::text AS step_finished
             FROM runtime_runs r LEFT JOIN runtime_run_steps s ON s.run_id = r.id
            WHERE r.id = ANY($1) ORDER BY r.id, s.step_key`,
          [ids],
        )
      ).rows;
    const before = await history();
    for (const id of ids) {
      await db.query(
        `INSERT INTO runtime_blobs (id, run_id, filename, mime_type, size_bytes, data)
           VALUES (gen_random_uuid(), $1, 'left.txt', 'text/plain', 4, 'left'::bytea)`,
        [id],
      );
    }

    await boot();
    const workflows = await eventually(
      () =>
        dbos.query<{ status: string; error: string | null; recovery_attempts: string }>(
          `SELECT status, error, recovery_attempts FROM dbos.workflow_status
            WHERE workflow_uuid = ANY($1) ORDER BY workflow_uuid`,
          [ids],
        ),
      (res) => res.rows.every((w) => w.status === 'SUCCESS' || w.status === 'ERROR'),
      'both workflows ended',
    );
    expect(workflows.rows.map((w) => [w.status, /Run already ended/.test(w.error ?? '')])).toEqual([
      ['ERROR', true],
      ['ERROR', true],
    ]);
    expect(workflows.rows.map((w, i) => Number(w.recovery_attempts) > attempts[i]!)).toEqual([true, true]);
    expect(await history()).toEqual(before);
    expect((await db.query(`SELECT 1 FROM runtime_blobs WHERE run_id = ANY($1)`, [ids])).rows).toEqual([]);
  }, 120_000);

  it('ends a run holding a decision its workflow can no longer resume, keeping who decided, and leaves one it can resume', async () => {
    const approval = { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 4_000 };
    for (const runId of ['stranded', 'resumable']) {
      expect(
        (await post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes: [approval] } }))
          .status,
      ).toBe(201);
    }
    await eventually(
      () =>
        db.query(`SELECT 1 FROM runtime_run_steps WHERE run_id = ANY($1) AND waiting_topic IS NOT NULL`, [
          [`${MOCK_USER_ID}:stranded`, `${MOCK_USER_ID}:resumable`],
        ]),
      (res) => res.rows.length === 2,
      'both parked',
    );
    await db.query(
      `UPDATE runtime_run_steps SET claimed_at = now(), claimed_by = $2, claimed_payload = '{"d":"never taken"}'
        WHERE run_id = ANY($1)`,
      [[`${MOCK_USER_ID}:stranded`, `${MOCK_USER_ID}:resumable`], MOCK_USER_ID],
    );
    await crash();
    await dbos.query(`UPDATE dbos.workflow_status SET recovery_attempts = 101 WHERE workflow_uuid = $1`, [
      `${MOCK_USER_ID}:stranded`,
    ]);
    // Past both waits' windows by the max the reboot runs with.
    await new Promise((r) => setTimeout(r, 4_000 + 6_000));

    // Holding the recorded outputs keeps the resumable run parked while the boot reaper looks at it.
    await dbos.query('BEGIN');
    await dbos.query('LOCK TABLE dbos.operation_outputs IN ACCESS EXCLUSIVE MODE');
    try {
      await boot({ RUN_MAX_DURATION_SECONDS: '5' });
      const stranded = await eventually(
        () =>
          db.query(
            `SELECT r.status, r.error, r.decided_by AS slot,
                    (SELECT string_agg(s.decided_by::text, ',') FROM runtime_run_steps s WHERE s.run_id = r.id) AS decided_by
               FROM runtime_runs r WHERE r.run_id = 'stranded'`,
          ),
        (res) => res.rows[0]?.status === 'error',
        'the stranded run reaped',
      );
      expect(stranded.rows[0].decided_by).toBe(MOCK_USER_ID);
      expect(stranded.rows[0].slot).toBe(MOCK_USER_ID);
      expect(stranded.rows[0].error).toMatch(
        /^Decided by .+, but the run could not resume to take the decision — run it again$/,
      );
      const resumable = await db.query(`SELECT status FROM runtime_runs WHERE run_id = 'resumable'`);
      expect(resumable.rows[0].status).toBe('waiting');
    } finally {
      await dbos.query('ROLLBACK');
    }
    expect((await completed('resumable')).outputs).toEqual({ approve: null });
  }, 120_000);

  it('keeps a claim a cancel left while its wait was taking it, when the workflow stops at entry, until its run is long over', async () => {
    const runKey = `${MOCK_USER_ID}:never-resumed`;
    const nodes = [{ kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: WINDOW_MS }];
    expect(
      (await post('/api/runs/async', { run_id: 'never-resumed', plan: { id: 'plan-never-resumed', nodes } }))
        .status,
    ).toBe(201);
    await eventually(
      () => parkedIn('never-resumed'),
      (p) => p.length === 1,
      'the approval parked',
    );
    const sysUrl = new URL(databaseUrl);
    sysUrl.pathname = `${sysUrl.pathname}_dbos`;
    const holder = new Client({ connectionString: sysUrl.toString() });
    await holder.connect();
    try {
      // The take cannot commit, so the cancel lands while the run is taking the decision, and the crash ends that take.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE dbos.operation_outputs IN EXCLUSIVE MODE');
      expect(
        (await post('/api/runs/never-resumed/events', { topic: 'approval', payload: { d: 'x' } })).status,
      ).toBe(200);
      await eventually(
        () =>
          dbos.query<{ query: string }>(
            `SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          ),
        (res) => res.rows.some((r) => /INSERT INTO\s+"?dbos"?\.operation_outputs/i.test(r.query)),
        'the take held',
      );
      expect((await post('/api/runs/never-resumed/cancel', {})).status).toBe(200);
      await crash();
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    const stepOf = async (): Promise<Record<string, unknown>> =>
      (
        await db.query(
          `SELECT status, waiting_topic, claimed_by, decided_by FROM runtime_run_steps WHERE run_id = $1`,
          [runKey],
        )
      ).rows[0] as Record<string, unknown>;
    const left = { status: 'running', waiting_topic: null, claimed_by: MOCK_USER_ID, decided_by: null };
    expect(await stepOf()).toEqual(left);

    // As a recovery of it would: the workflow runs again on a run that has already ended.
    await dbos.query(`UPDATE dbos.workflow_status SET status = 'PENDING' WHERE workflow_uuid = $1`, [runKey]);
    await boot();
    await eventually(
      () =>
        dbos.query<{ status: string }>(`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`, [
          runKey,
        ]),
      (res) => res.rows[0]?.status === 'ERROR',
      'the workflow stopped at its entry',
    );
    expect(await stepOf()).toEqual(left);
    const detail = await json('/api/runs/never-resumed');
    const step = (detail.steps as Array<Record<string, unknown>>)[0]!;
    expect([detail.status, detail.waiting, detail.decided_by, step.waiting, step.decided_by]).toEqual([
      'cancelled',
      null,
      null,
      null,
      null,
    ]);
    const listed = ((await json('/api/runs/waiting')).runs as Array<Record<string, unknown>>).filter(
      (r) => r.run_id === 'never-resumed',
    );
    expect(listed).toEqual([]);

    await db.query(`UPDATE runtime_runs SET finished_at = now() - interval '2 hours' WHERE id = $1`, [
      runKey,
    ]);
    await crash();
    await boot();
    await eventually(
      () => stepOf(),
      (s) => s.claimed_by === null,
      'the boot reap dropping the claim',
    );
    expect((await json('/api/runs/never-resumed')).status).toBe('cancelled');
  }, 120_000);
});
