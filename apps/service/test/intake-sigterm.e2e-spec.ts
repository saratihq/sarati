import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from 'pg';

import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase, withDatabase } from './support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

function webhookDoc(name: string, step: { node_type: string; parameters: Record<string, unknown> }) {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a request arrives',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      { id: 'step', name: 'Step', type_version: 1, position: { x: 300, y: 0 }, metadata: {}, ...step },
    ],
    edges: [
      {
        id: 'e-trigger-step',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'step',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** A webhook delivery acknowledged around a SIGTERM is never lost: its run completes, on this process or the next (child process, real DBOS). */
describe('webhook deliveries across a SIGTERM (e2e, real DBOS, child process)', () => {
  let databaseUrl = '';
  let systemDatabase = '';
  let db: Client;
  let service: ServiceProcess | undefined;
  let holding = true;
  const held: ServerResponse[] = [];
  const fixture = createServer((req, res) => {
    if (req.url === '/gate' && holding) {
      held.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  const eventually = async <T>(
    what: string,
    read: () => Promise<T> | T,
    done: (v: T) => boolean,
  ): Promise<T> => {
    for (let i = 0; i < 400; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`never saw ${what}\n${service?.log().slice(-4_000) ?? ''}`);
  };
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${service!.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const deploy = async (doc: Record<string, unknown>): Promise<string> => {
    const res = await post('/api/deploy', { workflow_json: doc });
    expect(res.status).toBe(201);
    return ((await res.json()) as { workflow_id: string }).workflow_id;
  };
  const serving = (): Promise<boolean> =>
    fetch(`${service!.base}/api/health`).then(
      () => true,
      () => false,
    );
  const runStatus = async (runId: string): Promise<string | undefined> =>
    (
      await db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE id = $1`, [
        `${MOCK_USER_ID}:${runId}`,
      ])
    ).rows[0]?.status;
  const workflowStatus = async (runId: string): Promise<string | undefined> => {
    const system = new Client({ connectionString: withDatabase(databaseUrl, systemDatabase) });
    await system.connect();
    try {
      const rows = await system.query<{ status: string }>(
        `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
        [`${MOCK_USER_ID}:${runId}`],
      );
      return rows.rows[0]?.status;
    } finally {
      await system.end();
    }
  };

  beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    systemDatabase = `${new URL(databaseUrl).pathname.slice(1)}_dbos`;
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    service = await bootService({ service: THIS_SERVICE, databaseUrl });
  }, 90_000);

  afterAll(async () => {
    await service?.crash();
    await db?.end();
    for (const res of held.splice(0)) res.end();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
  }, 30_000);

  it('a delivery still being admitted when SIGTERM lands is answered 202, and its run has completed when the service is back', async () => {
    const wf = await deploy(
      webhookDoc('admitted across a stop', { node_type: 'text.concat', parameters: { texts: ['ok'] } }),
    );
    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE runtime_runs IN SHARE ROW EXCLUSIVE MODE');
    let answered = false;
    const answer = post(`/api/hooks/${wf}/production`, { hello: 'sigterm' }).then((res) => {
      answered = true;
      return res;
    });
    try {
      await eventually(
        'the admission wait on the held runtime_runs',
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO runtime_runs%'`,
            )
          ).rows.length,
        (n) => n > 0,
      );
      const exited = service!.terminate();
      // Held as far into the stop as it can go: its DBOS shut down, or, while it still owes this delivery an answer, its server closed.
      await eventually(
        'the service stop as far as the held admission lets it',
        async () => {
          const dbos = await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname = $1`, [systemDatabase]);
          return dbos.rows.length === 0 || (!answered && !(await serving()));
        },
        (stopped) => stopped,
      );
      await locker.query('COMMIT');
      const res = await answer;
      expect(res.status).toBe(202);
      const runId = ((await res.json()) as { run_id: string }).run_id;
      await exited;

      service = await bootService({ service: THIS_SERVICE, databaseUrl });
      expect(
        await eventually(
          'the run complete',
          () => runStatus(runId),
          (s) => s === 'completed',
        ),
      ).toBe('completed');
      expect(await workflowStatus(runId)).toBe('SUCCESS');
    } finally {
      await locker.end();
    }
  }, 120_000);

  it('a run acknowledged just before SIGTERM, cut off once the stop outlasts its grace, completes when the service is back', async () => {
    const wf = await deploy(
      webhookDoc('cut off by a stop', {
        node_type: 'http.send_request',
        parameters: {
          method: 'GET',
          url: `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/gate`,
        },
      }),
    );
    const res = await post(`/api/hooks/${wf}/production`, { hello: 'grace' });
    const exited = service!.terminate();
    expect(res.status).toBe(202);
    const runId = ((await res.json()) as { run_id: string }).run_id;
    await eventually(
      'the step reach its fixture',
      () => held.length,
      (n) => n === 1,
    );
    await eventually(
      'the service stop serving',
      () => serving(),
      (up) => !up,
    );

    await service!.crash();
    await exited;
    holding = false;
    for (const late of held.splice(0)) late.end();

    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    expect(
      await eventually(
        'the run complete',
        () => runStatus(runId),
        (s) => s === 'completed',
      ),
    ).toBe('completed');
    expect(await workflowStatus(runId)).toBe('SUCCESS');
  }, 120_000);

  it('a run killed between its record and its workflow save, reaped while the service was down, runs once when its id is sent again', async () => {
    const runId = 'killed-before-save';
    const plan = {
      id: 'rearmed',
      nodes: [
        { kind: 'action', id: 'say', actionId: 'text.concat', props: { texts: ['again'], separator: '' } },
      ],
    };
    const system = new Client({ connectionString: withDatabase(databaseUrl, systemDatabase) });
    await system.connect();
    await system.query('BEGIN');
    await system.query('LOCK TABLE dbos.workflow_status IN SHARE ROW EXCLUSIVE MODE');
    try {
      const first = post('/api/runs/async', { plan, run_id: runId }).catch(() => null);
      await eventually(
        'the admission wait on the held workflow_status',
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = $1 AND wait_event_type = 'Lock'
                  AND query LIKE 'INSERT INTO "dbos".workflow_status%'`,
              [systemDatabase],
            )
          ).rows.length,
        (n) => n > 0,
      );
      await service!.crash();
      expect(await first).toBeNull();
    } finally {
      await system.query('ROLLBACK');
      await system.end();
    }
    expect([await runStatus(runId), await workflowStatus(runId)]).toEqual(['running', undefined]);
    await db.query(`UPDATE runtime_runs SET started_at = now() - interval '2 hours' WHERE id = $1`, [
      `${MOCK_USER_ID}:${runId}`,
    ]);

    service = await bootService({ service: THIS_SERVICE, databaseUrl });
    await eventually(
      'the boot reap end the run',
      () => runStatus(runId),
      (s) => s === 'error',
    );
    const again = await post('/api/runs/async', { plan, run_id: runId });
    expect(again.status).toBe(201);
    await eventually(
      'the run complete',
      () => runStatus(runId),
      (s) => s === 'completed',
    );
    await eventually(
      'its workflow succeed',
      () => workflowStatus(runId),
      (s) => s === 'SUCCESS',
    );
    const steps = await db.query<{ node_id: string }>(
      `SELECT node_id FROM runtime_run_steps WHERE run_id = $1`,
      [`${MOCK_USER_ID}:${runId}`],
    );
    expect(steps.rows.map((r) => r.node_id)).toEqual(['say']);
  }, 120_000);
});
