import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';

import { Client } from 'pg';

import { unpackBuild, type EarlierBuild } from '../support/earlier-build';
import { GOLDEN_DIR, restoreGoldenHistory, type GoldenHistory } from '../support/golden-history';
import { DRIVES, deploy, driveGolden, recordedCallee, type GoldenOutcome } from '../support/golden-outcome';
import { ECHO_CHILD, LANE_CHILD, ir, irEdge, irNode } from '../support/golden-docs';
import { bootService } from '../support/service-process';
import { ADMIN_URL, E2E_RUN_ID_ENV, createE2eDatabase, dropRunDatabases } from '../support/test-db';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const WINDOW_MS = 10 * 60_000;

const APP_TABLES: Array<[table: string, key: string, order: string]> = [
  ['runtime_runs', 'id', 'id'],
  ['runtime_run_steps', 'run_id', 'step_key'],
  ['runtime_blobs', 'run_id', 'filename'],
];
const DBOS_TABLES: Array<[table: string, key: string, order: string]> = [
  ['workflow_status', 'workflow_uuid', 'workflow_uuid'],
  ['workflow_inputs', 'workflow_uuid', 'workflow_uuid'],
  ['operation_outputs', 'workflow_uuid', 'function_id'],
  ['notifications', 'destination_uuid', 'created_at_epoch_ms'],
  ['workflow_events', 'workflow_uuid', 'key'],
  ['workflow_events_history', 'workflow_uuid', 'function_id'],
  ['streams', 'workflow_uuid', '"offset"'],
];

interface Recording {
  db: Client;
  dbos: Client;
  runKey: string;
  /** Requests the HTTP fixture is holding unanswered. */
  held: () => number;
}

interface Shape {
  name: string;
  start(
    post: (path: string, body: unknown) => Promise<Response>,
    runId: string,
    http: string,
  ): Promise<Response>;
  ready(at: Recording): Promise<boolean>;
  afterCrash?(at: Recording): Promise<void>;
}

const code = (id: string) => ({ kind: 'code', id, language: 'js', code: `return { ran: '${id}' };` });
const wait = (id: string) => ({ kind: 'waitForEvent', id, topic: 'approval', timeoutMs: WINDOW_MS });
const delay = (id: string) => ({ kind: 'delay', id, ms: WINDOW_MS });
const fork = (...branches: unknown[][]) => ({ kind: 'parallel', id: 'fork', branches });
const get = (id: string, url: string) => ({
  kind: 'action',
  id,
  actionId: 'http.send_request',
  props: { method: 'GET', url },
});

const irWait = irNode('approve', 'orchestr:wait_for_event', { topic: 'approval', timeout_ms: WINDOW_MS });
const plan =
  (...nodes: unknown[]): Shape['start'] =>
  (post, runId) =>
    post('/api/runs/async', { run_id: runId, plan: { id: `plan-${runId}`, nodes } });

// Parked on `n` waits, each with the deadline its receive recorded; a build before 033 parks its run's row, not its steps.
const parked =
  (n: number) =>
  async ({ db, dbos, runKey }: Recording): Promise<boolean> => {
    const rows = await db.query(
      `SELECT 1 FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id AND r.status = 'waiting'
        WHERE s.run_id = $1 AND s.kind IN ('waitForEvent', 'delay') AND s.finished_at IS NULL`,
      [runKey],
    );
    const deadlines = await dbos.query(
      `SELECT 1 FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = 'DBOS.sleep'`,
      [runKey],
    );
    return rows.rowCount === n && deadlines.rowCount === n;
  };

const waitFanOut: Pick<Shape, 'start' | 'ready'> = {
  start: plan(fork([wait('a1')], [wait('a2')])),
  ready: parked(2),
};

// A run from before waits on one topic were told apart: its args carry no routing, and its waits no delivery topic.
const unrouted: NonNullable<Shape['afterCrash']> = async ({ db, dbos, runKey }) => {
  const args = await dbos.query(
    `UPDATE dbos.workflow_status SET inputs = replace(inputs, ',"sharedTopicsByStep":true', '')
      WHERE workflow_uuid = $1 AND inputs LIKE '%,"sharedTopicsByStep":true%'`,
    [runKey],
  );
  if (args.rowCount !== 1) throw new Error(`${runKey}: no routing flag to take out of its args`);
  await db.query(`UPDATE runtime_run_steps SET delivery_topic = NULL WHERE run_id = $1`, [runKey]);
};

// Publish `child` so another workflow can call it, and answer its id.
const callable = async (
  post: (path: string, body: unknown) => Promise<Response>,
  child: unknown,
): Promise<string> => {
  const deployed = await post('/api/deploy', { workflow_json: child });
  const body = (await deployed.json()) as { workflow_id?: string; is_live?: boolean };
  if (!deployed.ok || !body.workflow_id || body.is_live !== true) {
    throw new Error(`the called workflow did not go live: ${deployed.status} ${JSON.stringify(body)}`);
  }
  return body.workflow_id;
};

/** The shapes of design §2.6, each recorded as its run stands at the crash. */
const SHAPES: Shape[] = [
  { name: 'linear-parked', start: plan(code('prep'), wait('approve')), ready: parked(1) },
  {
    name: 'parked-before-fan-out',
    start: plan(wait('approve'), fork([code('a')], [code('b')])),
    ready: parked(1),
  },
  {
    name: 'inside-step-fan-out',
    start: (post, runId, http) =>
      plan(fork([get('a', `${http}/answer`)], [get('b', `${http}/hold`)]))(post, runId, http),
    ready: async ({ dbos, runKey, held }) =>
      held() === 1 &&
      (
        await dbos.query(
          `SELECT 1 FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name LIKE '%fork|0/a'`,
          [runKey],
        )
      ).rowCount === 1,
  },
  { name: 'inside-wait-fan-out', ...waitFanOut },
  { name: 'inside-timer-fan-out', start: plan(fork([delay('t1')], [delay('t2')])), ready: parked(2) },
  {
    name: 'parked-after-fan-out',
    start: plan(fork([code('a')], [code('b')]), wait('approve')),
    ready: parked(1),
  },
  {
    name: 'agent-tool-calls',
    start: (post, runId) =>
      post('/api/runs/from-ir', {
        run_id: runId,
        await_ms: 0,
        workflow_ir: ir(
          [
            irNode('agent', 'orchestr:agent', {
              model: { provider: 'claude', model: 'claude-opus-4-8' },
              system_prompt: 'You look things up.',
              max_steps: 5,
              input: 'Look it up.',
            }),
            irNode('tool', 'text.concat', { tool_name: 'lookup', texts: ['looked-up'], separator: '' }),
            irWait,
          ],
          [irEdge('agent', 'tool', 'tool'), irEdge('agent', 'approve')],
        ),
      }),
    ready: parked(1),
  },
  {
    name: 'pins',
    start: (post, runId) =>
      post('/api/runs/from-ir', {
        run_id: runId,
        await_ms: 0,
        pins: { first: { pinned: true } },
        workflow_ir: ir(
          [
            irNode('first', 'orchestr:code', { language: 'js', code: 'return { ran: "first" };' }),
            irNode('second', 'orchestr:code', { language: 'js', code: 'return { ran: "second" };' }),
            irWait,
          ],
          [irEdge('first', 'second'), irEdge('second', 'approve')],
        ),
      }),
    ready: parked(1),
  },
  { name: 'shared-receive-wait-fan-out', ...waitFanOut, afterCrash: unrouted },
  {
    name: 'shared-receive-before-fan-out',
    start: plan(
      { kind: 'waitForEvent', id: 'gate', topic: 'gate', timeoutMs: WINDOW_MS },
      fork([wait('a1')], [wait('a2')]),
    ),
    ready: parked(1),
    afterCrash: unrouted,
  },
  {
    name: 'parked-in-error-lane',
    start: plan({
      kind: 'code',
      id: 'boom',
      language: 'js',
      code: 'throw new Error("boom failed");',
      onErrorBranch: [wait('approve')],
    }),
    ready: parked(1),
  },
  {
    name: 'after-call-workflow',
    start: async (post, runId) =>
      post('/api/runs/from-ir', {
        run_id: runId,
        await_ms: 0,
        workflow_ir: ir(
          [
            irNode('call', 'orchestr:call_workflow', {
              workflow_id: await callable(post, ECHO_CHILD),
              input: { q: 'hi' },
            }),
            irWait,
          ],
          [irEdge('call', 'approve')],
        ),
      }),
    ready: parked(1),
  },
  {
    name: 'parked-before-call-workflow',
    start: async (post, runId) =>
      post('/api/runs/from-ir', {
        run_id: runId,
        await_ms: 0,
        workflow_ir: ir(
          [
            irWait,
            irNode('call', 'orchestr:call_workflow', {
              workflow_id: await callable(post, LANE_CHILD),
              input: { q: 'hi' },
            }),
          ],
          [irEdge('approve', 'call')],
        ),
      }),
    ready: parked(1),
  },
];

async function eventually(what: string, done: () => Promise<boolean>, log: () => string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await done().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never saw ${what}\n${log().slice(-4_000)}`);
}

function holdingFixture(): { server: Server; held: () => number } {
  let held = 0;
  const server = createHttpServer((req, res) => {
    if (req.url === '/hold') {
      held += 1;
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return { server, held: () => held };
}

async function dump(client: Client, schema: string, tables: typeof APP_TABLES, runKey: string) {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [table, key, order] of tables) {
    const res = await client.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(t) AS row FROM ${schema}.${table} t WHERE ${key} = $1 ORDER BY ${order}`,
      [runKey],
    );
    if (res.rows.length > 0) out[table] = res.rows.map((r) => r.row);
  }
  return out;
}

async function record(
  r0: EarlierBuild,
  build: string,
  shape: Shape,
  http: string,
  held: () => number,
): Promise<GoldenHistory> {
  const databaseUrl = await createE2eDatabase(ADMIN_URL, join(r0.service, 'db', 'schema.sql'));
  const runId = `golden-${shape.name}`;
  const runKey = `${MOCK_USER_ID}:${runId}`;
  const service = await bootService({ service: r0.service, databaseUrl, earlier: true });
  const db = new Client({ connectionString: databaseUrl });
  const sysUrl = new URL(databaseUrl);
  sysUrl.pathname = `${sysUrl.pathname}_dbos`;
  const dbos = new Client({ connectionString: sysUrl.toString() });
  try {
    await db.connect();
    await dbos.connect();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${service.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const started = await shape.start(post, runId, http);
    if (!started.ok) throw new Error(`${shape.name}: ${started.status} ${await started.text()}`);
    const at: Recording = { db, dbos, runKey, held };
    await eventually(`${shape.name} at its crash point`, () => shape.ready(at), service.log);
    await service.crash();
    await shape.afterCrash?.(at);
    const app = await dump(db, 'public', APP_TABLES, runKey);
    return {
      build,
      recordedAt: Date.now(),
      runId,
      orgId: (app.runtime_runs?.[0]?.org_id as string | null | undefined) ?? null,
      app,
      dbos: await dump(dbos, 'dbos', DBOS_TABLES, runKey),
    };
  } finally {
    await service.crash();
    await Promise.allSettled([db.end(), dbos.end()]);
  }
}

// What the build that recorded `golden` (`<build>/<shape>`) makes of it when it recovers: restored on a fresh database, then driven.
async function outcome(r0: EarlierBuild, golden: string, raw: string): Promise<GoldenOutcome> {
  const shape = basename(golden);
  const drive = DRIVES[shape]!;
  const databaseUrl = await createE2eDatabase(ADMIN_URL, join(r0.service, 'db', 'schema.sql'));
  const db = new Client({ connectionString: databaseUrl });
  const sysUrl = new URL(databaseUrl);
  sysUrl.pathname = `${sysUrl.pathname}_dbos`;
  const dbos = new Client({ connectionString: sysUrl.toString() });
  let service = await bootService({ service: r0.service, databaseUrl, earlier: true });
  try {
    await db.connect();
    await dbos.connect();
    // Served once, the mock user has the org a restore moves its run into.
    await fetch(`${service.base}/api/runs/waiting`);
    const callee = recordedCallee(raw);
    const replace = drive.calls && callee ? { [callee]: await deploy(service.base, drive.calls) } : {};
    await service.crash();
    await restoreGoldenHistory(db, dbos, golden, shape, replace);
    service = await bootService({ service: r0.service, databaseUrl, earlier: true });
    return await driveGolden(service.base, db, dbos, shape, drive);
  } finally {
    await service.crash();
    await Promise.allSettled([db.end(), dbos.end()]);
  }
}

// Records every shape, or those named after the sha, on the build at that sha.
async function main(): Promise<void> {
  const [build, ...only] = process.argv.slice(2);
  if (!build) throw new Error('usage: pnpm golden:record <sha of the build to record> [shape…]');
  const runId = randomBytes(4).toString('hex');
  process.env[E2E_RUN_ID_ENV] = runId;
  const r0 = unpackBuild(build);
  const { server, held } = holdingFixture();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const http = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = join(GOLDEN_DIR, build.slice(0, 7));
  mkdirSync(dir, { recursive: true });
  try {
    for (const shape of SHAPES.filter((s) => only.length === 0 || only.includes(s.name))) {
      const history = await record(r0, build, shape, http, held);
      const file = join(dir, `${shape.name}.json`);
      writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`);
      if (DRIVES[shape.name]) {
        const recovered = await outcome(r0, `${basename(dir)}/${shape.name}`, JSON.stringify(history));
        writeFileSync(file, `${JSON.stringify({ ...history, outcome: recovered }, null, 2)}\n`);
      }
      console.log(`recorded ${shape.name}`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
    r0.remove();
    const failed = await dropRunDatabases(ADMIN_URL, runId);
    if (failed.length > 0) console.error(`left behind: ${failed.join(', ')}`);
  }
}

void main();
