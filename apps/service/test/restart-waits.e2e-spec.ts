import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

import { Client } from 'pg';

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

  it('lists the parallel waits of a run from before waits were told apart once; one of them takes the decision and the other ends with none', async () => {
    const runKey = `${MOCK_USER_ID}:legacy`;
    const approval = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
    const fork = { kind: 'parallel', id: 'fork', branches: [[approval('a1')], [approval('a2')]] };
    expect(
      (await post('/api/runs/async', { run_id: 'legacy', plan: { id: 'plan-legacy', nodes: [fork] } }))
        .status,
    ).toBe(201);
    await eventually(
      () => parkedIn('legacy'),
      (p) => p.length === 2,
      'both legacy waits parked',
    );

    await crash();
    const rewritten = await dbos.query(
      `UPDATE dbos.workflow_status SET inputs = replace(inputs, '"sharedTopicsByStep":true', '"sharedTopicsByStep":false')
        WHERE workflow_uuid = $1 AND inputs LIKE '%"sharedTopicsByStep":true%'`,
      [runKey],
    );
    expect(rewritten.rowCount).toBe(1);
    await boot();
    await eventually(
      () =>
        db.query<{ step_key: string }>(
          `SELECT step_key FROM runtime_run_steps
            WHERE run_id = $1 AND waiting_topic = 'approval' AND finished_at IS NULL AND delivery_topic IS NULL`,
          [runKey],
        ),
      (res) => res.rows.length === 2,
      'both legacy waits re-parked on the topic itself',
    );

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

    const decided = await post('/api/runs/legacy/events', { topic: 'approval', payload: { d: 'x' } });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toEqual({ status: 'sent', step_key: null });
    const outputs = (await completed('legacy')).outputs as Record<string, unknown>;
    expect([outputs.a1, outputs.a2].sort()).toEqual([null, { d: 'x' }].sort());
    expect((await json('/api/runs/legacy')).decided_by).toMatchObject({ id: MOCK_USER_ID });
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
        () => db.query(`SELECT status, error, decided_by FROM runtime_runs WHERE run_id = 'stranded'`),
        (res) => res.rows[0]?.status === 'error',
        'the stranded run reaped',
      );
      expect(stranded.rows[0].decided_by).toBe(MOCK_USER_ID);
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
});
