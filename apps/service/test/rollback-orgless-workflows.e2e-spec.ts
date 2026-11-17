import { createHmac, randomUUID } from 'node:crypto';

import { fernetEncrypt } from '../src/common/crypto/fernet';
import { lastReleaseWithout } from './support/earlier-build';
import { ECHO_CHILD, ir, irEdge, irNode } from './support/golden-docs';
import { insertPersonalOrgs } from './support/personal-org';
import { MOCK_USER_ID, rollbackSuite } from './support/rollback';

const BEFORE_050 = lastReleaseWithout(
  'apps/service/db/migrations/050_orgless_workflows_to_personal_workspace.sql',
);
const SECRET = 'orgless-across-a-rollback';

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

interface Upgraded {
  workflows: unknown[];
  pointers: unknown[];
  secrets: Array<{ workflow_id: string; environment_id: string | null; secret: string }>;
}

/** A webhook verifying GitHub signatures, then an approval, then a call to `callee`. */
const parentDoc = (callee: string) =>
  ir(
    [
      irNode('trigger', 'orchestr:webhook', { verification: { preset: 'github' } }),
      irNode('approval', 'orchestr:wait_for_event', { topic: 'approval', timeout_ms: 3_600_000 }),
      irNode('call', 'orchestr:call_workflow', { workflow_id: callee }),
    ],
    [irEdge('trigger', 'approval'), irEdge('approval', 'call')],
  );

/** Workflows made in no workspace, across the last release before 050 and this build on a database it upgraded (child processes, DBOS on, mock auth). */
describe(`a workflow made in no workspace across a rollback to ${BEFORE_050.tag} and back (e2e)`, () => {
  const rollback = rollbackSuite(BEFORE_050.sha, () => undefined);
  const home = randomUUID();
  const [parent, callee, parentV1, calleeV1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let base = '';

  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const deliver = (signed: boolean): Promise<Answer> => {
    const raw = JSON.stringify({ title: 'hello' });
    const signature = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    return fetch(`${base}/api/hooks/${parent}/production`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signed ? { 'x-hub-signature-256': signature } : {}),
      },
      body: raw,
    }).then(async (res) => ({
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    }));
  };
  const listed = async (): Promise<string[]> =>
    ((await call('GET', '/api/workflows')).body.workflows as Array<{ id: string }>).map((w) => w.id).sort();
  const runOf = (status: string) =>
    call('POST', '/api/runs/from-ir', {
      workflow_ir: ir([irNode('say', 'text.concat', { texts: [status], separator: '' })], []),
      workflow_id: parent,
    });
  const ended = (runId: string) =>
    rollback.eventually(
      rollback.runs,
      (runs) => runs[runId] !== undefined && !['running', 'waiting'].includes(runs[runId].status),
      `run ${runId} ending`,
    );
  const state = async (): Promise<Upgraded> => {
    const db = rollback.db();
    return {
      workflows: (await db.query(`SELECT id, org_id FROM workflows ORDER BY id`)).rows,
      pointers: (
        await db.query(
          `SELECT workflow_id, environment, environment_id FROM workflow_env_pointers ORDER BY 1, 2`,
        )
      ).rows,
      secrets: (
        await db.query<Upgraded['secrets'][number]>(
          `SELECT workflow_id, environment_id, secret FROM webhook_trigger_secrets ORDER BY 1, 2`,
        )
      ).rows,
    };
  };

  it('moves them into their owner’s personal workspace, where a run started in none finishes its call; going back keeps them there, and a call such a run makes there is refused', async () => {
    const db = rollback.db();
    await db.query(
      `INSERT INTO users (id, email, name, hashed_password, created_at, updated_at) VALUES ($1, 'test@example.com', 'Test User', 'mock', now(), now())`,
      [MOCK_USER_ID],
    );
    await insertPersonalOrgs(db, { id: home, userId: MOCK_USER_ID, name: 'Test User' });
    for (const [id, name, version, doc] of [
      [parent, 'Parent', parentV1, parentDoc(callee)],
      [callee, 'Callee', calleeV1, ECHO_CHILD],
    ] as const) {
      await db.query(
        `INSERT INTO workflows (id, name, user_id, org_id, active_version_id) VALUES ($1, $2, $3, NULL, NULL)`,
        [id, name, MOCK_USER_ID],
      );
      await db.query(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, workflow_ir) VALUES ($1, $2, 1, $3, $3)`,
        [version, id, JSON.stringify(doc)],
      );
      await db.query(`UPDATE workflows SET active_version_id = $1 WHERE id = $2`, [version, id]);
      await db.query(
        `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id) VALUES ($1, 'production', $2)`,
        [id, version],
      );
    }
    await db.query(
      `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret) VALUES ($1, NULL, 'trigger', $2)`,
      [parent, fernetEncrypt(process.env.FERNET_KEY!, SECRET)],
    );

    await rollback.migrate('earlier');
    let service = await rollback.boot('earlier');
    base = service.base;
    const parked: string[] = [];
    for (let i = 0; i < 2; i++) {
      const fired = await deliver(true);
      expect(fired.status).toBe(202);
      parked.push(fired.body.run_id as string);
    }
    const [finishes, refused] = parked as [string, string];
    await rollback.eventually(
      rollback.runs,
      (runs) => parked.every((id) => runs[id]?.status === 'waiting'),
      'both runs parked on their approval',
    );
    await service.crash();

    const upgraded = (await rollback.migrate('this')).split('\n').filter((line) => line.startsWith('050 '));
    const [production, staging, uat] = (
      await db.query<{ id: string }>(
        `SELECT id FROM environments WHERE org_id = $1 AND name IN ('production', 'staging', 'uat') ORDER BY name`,
        [home],
      )
    ).rows.map((r) => r.id);
    const linked = (wf: string, name: string): string =>
      `050 linked workflow ${name} (${wf}) to environment production of workspace ${home}: each trigger its version there holds starts as the service starts, one that listens as an app's account once the account assigned to that app there serves it, and a run started there takes that environment's accounts (assigned: none), an app with none answering 428 until one is assigned`;
    expect(upgraded.sort()).toEqual(
      [
        `050 moved workflow Parent (${parent}) of test@example.com into their personal workspace ${home}, with its 2 unfinished run(s): it is on their dashboard there, and Run, an async start and Test this branch reach it`,
        `050 moved workflow Callee (${callee}) of test@example.com into their personal workspace ${home}, with its 0 unfinished run(s): it is on their dashboard there, and Run, an async start and Test this branch reach it`,
        linked(parent, 'Parent'),
        linked(callee, 'Callee'),
        `050 gave the signing secret of trigger trigger in workflow Parent (${parent}), which named no environment, to each environment of workspace ${home} without its own (production, staging, uat): a delivery there is checked against it wherever that trigger has Verify signatures on`,
      ].sort(),
    );
    const moved = await state();
    expect(moved.workflows).toEqual([parent, callee].sort().map((id) => ({ id, org_id: home })));
    expect(new Set(moved.secrets.map((s) => s.environment_id))).toEqual(new Set([production, staging, uat]));

    // The two parked runs now hold the workspace's two places, so a third is refused until one of them ends.
    service = await rollback.boot('this', { WORKSPACE_MAX_UNFINISHED_RUNS: '2' });
    base = service.base;
    expect((await runOf('a third')).status).toBe(429);
    expect(
      (await call('POST', `/api/runs/${finishes}/events`, { topic: 'approval', payload: { ok: true } }))
        .status,
    ).toBe(200);
    const finished = await ended(finishes);
    expect({ status: finished[finishes]!.status, error: finished[finishes]!.error }).toEqual({
      status: 'completed',
      error: null,
    });
    expect((await runOf('a second')).status).toBe(201);
    expect(await listed()).toEqual([parent, callee].sort());
    expect((await deliver(false)).status).toBe(401);
    await service.crash();

    expect(await rollback.migrate('earlier')).toContain('schema is up to date');
    service = await rollback.boot('earlier');
    base = service.base;
    expect(await listed()).toEqual([parent, callee].sort());
    expect((await runOf('there')).status).toBe(201);
    expect((await deliver(false)).status).toBe(401);
    expect(
      (await call('POST', `/api/runs/${refused}/events`, { topic: 'approval', payload: { ok: true } }))
        .status,
    ).toBe(200);
    const there = await ended(refused);
    expect({ status: there[refused]!.status, error: there[refused]!.error }).toEqual({
      status: 'error',
      error: expect.stringContaining(`Sub-workflow "${callee}" not found or not accessible.`),
    });
    await service.crash();

    const back = await rollback.migrate('this');
    expect(back.split('\n').filter((line) => line.startsWith('050 '))).toEqual([]);
    expect(await state()).toEqual(moved);
    service = await rollback.boot('this');
    base = service.base;
    expect(await listed()).toEqual([parent, callee].sort());
    await service.crash();
  }, 300_000);
});
