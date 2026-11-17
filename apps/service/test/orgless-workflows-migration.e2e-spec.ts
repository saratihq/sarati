import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import type request from 'supertest';

import { mintSession } from '../src/auth/local/local-session';
import { fernetEncrypt } from '../src/common/crypto/fernet';
import { CANARIES } from '../src/database/schema-guard';
import { seedDefaultEnvironments } from '../src/environments/default-environments';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggerSignalsService } from '../src/triggers/trigger-signals.service';
import { insertApiKey } from './support/api-keys';
import { ir, irEdge, irNode, webhookDoc } from './support/golden-docs';
import { pause } from './support/lock-probes';
import { insertPersonalOrgs } from './support/personal-org';
import { THIS_SERVICE } from './support/service-process';
import { SSO_SECRET_KEY, bootSsoApp, from, snapshotEnv } from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M050_FILE = '050_orgless_workflows_to_personal_workspace.sql';
const M050 = readFileSync(join(__dirname, '..', 'db', 'migrations', M050_FILE), 'utf8');
const SECRET = 'orgless-signing-secret';
const CIPHERTEXT = fernetEncrypt(process.env.FERNET_KEY!, SECRET);

/** What the image runs before the service: every migration, in order, on the database; what it printed. */
async function migrate(databaseUrl: string): Promise<string[]> {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/migrate-db.mjs'], {
    cwd: THIS_SERVICE,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return `${stdout}${stderr}`.split('\n');
}

const upgradeLines = (out: string[]): string[] => out.filter((line) => /^\d{3} /.test(line));

/** A webhook workflow labelled `label` whose trigger verifies GitHub signatures. */
const hookDoc = (label: string) => ({
  ...ir(
    [
      irNode('trigger', 'orchestr:webhook', { verification: { preset: 'github' } }),
      irNode('say', 'text.concat', { texts: [`${label}: `, '{{trigger.title}}'], separator: '' }),
    ],
    [irEdge('trigger', 'say')],
  ),
  name: label,
});

/** A workflow with no trigger that says `text`. */
const sayDoc = (text: string) => ir([irNode('say', 'text.concat', { texts: [text], separator: '' })], []);

/** A workflow as an earlier release left it: its main branch's versions, the newest live, and its pointers by name alone. */
async function insertWorkflow(
  db: Client,
  wf: {
    id: string;
    name: string;
    userId: string | null;
    orgId: string | null;
    versions?: Array<{ id: string; doc: unknown }>;
    pointers?: Record<string, string>;
  },
): Promise<void> {
  await db.query(`INSERT INTO workflows (id, name, user_id, org_id) VALUES ($1, $2, $3, $4)`, [
    wf.id,
    wf.name,
    wf.userId,
    wf.orgId,
  ]);
  const versions = wf.versions ?? [];
  if (versions.length === 0) return;
  const main = randomUUID();
  await db.query(
    `INSERT INTO workflow_branches (id, workflow_id, name, is_default) VALUES ($1, $2, 'main', true)`,
    [main, wf.id],
  );
  for (const [i, v] of versions.entries()) {
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, workflow_ir, branch_id, parent_id, created_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, now() - make_interval(hours => $7))`,
      [v.id, wf.id, i + 1, JSON.stringify(v.doc), main, versions[i - 1]?.id ?? null, versions.length - i],
    );
  }
  const head = versions.at(-1)!.id;
  await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [head, main]);
  await db.query(`UPDATE workflows SET default_branch_id = $1, active_version_id = $2 WHERE id = $3`, [
    main,
    head,
    wf.id,
  ]);
  for (const [environment, versionId] of Object.entries(wf.pointers ?? {})) {
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id) VALUES ($1, $2, $3)`,
      [wf.id, environment, versionId],
    );
  }
}

/** 050 on workflows an account made in no workspace, through `db:migrate`, which re-runs it on every boot. Scratch DB. */
describe('migration 050: a workflow made in no workspace moves into its owner’s personal workspace (scratch DB)', () => {
  let databaseUrl = '';
  let db: Client;

  const ada = randomUUID();
  const bo = randomUUID();
  const adaHome = randomUUID();
  const team = randomUUID();
  const [orgless, bos, ownerless, teamFlow, chained] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const [v1, v2, boV1, teamV1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const slack = randomUUID();
  const env: Record<string, string> = {};
  let boHome = '';
  let teamProduction = '';
  let firstRun: string[] = [];

  const sql = (text: string, values?: unknown[]) => db.query(text, values);
  const canaryPasses = async (): Promise<boolean> =>
    ((await sql(CANARIES.find((c) => c.migration === M050_FILE)!.probe)).rowCount ?? 0) > 0;
  const snapshot = async (): Promise<Record<string, unknown[]>> => ({
    workflows: (await sql(`SELECT id, org_id, active_version_id FROM workflows ORDER BY id`)).rows,
    pointers: (
      await sql(
        `SELECT workflow_id, environment, environment_id, version_id FROM workflow_env_pointers ORDER BY 1, 2`,
      )
    ).rows,
    secrets: (
      await sql(
        `SELECT workflow_id, environment_id, node_id, secret FROM webhook_trigger_secrets ORDER BY 1, 2, 3`,
      )
    ).rows,
    runs: (await sql(`SELECT id, org_id FROM runtime_runs ORDER BY id`)).rows,
  });

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();

    await sql(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'a@example.com', 'Ada', now(), now()), ($2, 'b@example.com', 'Bo', now(), now())`,
      [ada, bo],
    );
    // Ada's workspace as an owner added back to it may have left it: staging deleted, a qa of their own, an account in qa's slot.
    await insertPersonalOrgs(db, { id: adaHome, userId: ada, name: 'Ada' });
    await sql(`DELETE FROM environments WHERE org_id = $1 AND name = 'staging'`, [adaHome]);
    await sql(`INSERT INTO environments (org_id, name, is_prod) VALUES ($1, 'qa', false)`, [adaHome]);
    for (const { id, name } of (await sql(`SELECT id, name FROM environments WHERE org_id = $1`, [adaHome]))
      .rows as Array<{ id: string; name: string }>) {
      env[name] = id;
    }
    await sql(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential) VALUES ($1, $2, 'slack', 'token', 'x')`,
      [slack, ada],
    );
    await sql(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'slack', $2)`,
      [env.qa, slack],
    );
    await sql(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at, environments_seeded_at)
       VALUES ($1, 'Team', false, now(), now(), now())`,
      [team],
    );
    await sql(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [team, ada],
    );
    await seedDefaultEnvironments(db, team);
    teamProduction = (
      await sql(`SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`, [team])
    ).rows[0]!.id as string;

    await insertWorkflow(db, {
      id: orgless,
      name: 'Orgless Flow',
      userId: ada,
      orgId: null,
      versions: [
        { id: v1, doc: hookDoc('v1') },
        { id: v2, doc: hookDoc('v2') },
      ],
      pointers: { production: v2, staging: v1, qa: v1, default: v1 },
    });
    await insertWorkflow(db, {
      id: bos,
      name: 'Bo Flow',
      userId: bo,
      orgId: null,
      versions: [{ id: boV1, doc: webhookDoc('Bo Flow') }],
      pointers: { production: boV1 },
    });
    await insertWorkflow(db, { id: ownerless, name: 'Ownerless Flow', userId: null, orgId: null });
    await insertWorkflow(db, { id: chained, name: 'Chained Flow', userId: ada, orgId: null });
    // Live in its workspace's production with no trigger, so no activation ever stands for it.
    await insertWorkflow(db, {
      id: teamFlow,
      name: 'Team Flow',
      userId: ada,
      orgId: team,
      versions: [{ id: teamV1, doc: sayDoc('team') }],
    });
    await sql(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, environment_id) VALUES ($1, 'production', $2, $3)`,
      [teamFlow, teamV1, teamProduction],
    );
    await sql(
      `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret) VALUES ($1, NULL, 'trigger', $2)`,
      [orgless, CIPHERTEXT],
    );
    await sql(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, workflow_id, source, org_id, parent_run_id, finished_at)
       VALUES ($4, 'done', $1, 'p', 'completed', $2, 'webhook', NULL, NULL, now()),
              ($5, 'parked', $1, 'p', 'waiting', $2, 'webhook', NULL, NULL, NULL),
              ('sub_from_team', 'sub_from_team', $1, 'p', 'completed', $2, 'sub_workflow', $3, $6, now()),
              ($7, 'team_parent', $1, 'p', 'completed', $8, 'manual', $3, NULL, now()),
              ('sub_before_028', 'sub_before_028', $1, 'p', 'completed', $2, 'sub_workflow', NULL, $7, now()),
              ('subsub_before_028', 'subsub_before_028', $1, 'p', 'completed', $9, 'sub_workflow', NULL, 'sub_before_028', now())`,
      [
        ada,
        orgless,
        team,
        `${ada}:done`,
        `${ada}:parked`,
        `${ada}:team-caller`,
        `${ada}:team-parent`,
        teamFlow,
        chained,
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await db.end();
  });

  it('moves each into its owner’s workspace — linking its pointers by name, dropping one the workspace has no environment for, giving its secret to each environment, its runs there — and leaves one with no owner', async () => {
    expect(await canaryPasses()).toBe(false);
    firstRun = await migrate(databaseUrl);
    boHome = (await sql(`SELECT id FROM organizations WHERE personal_owner_id = $1`, [bo])).rows[0]!
      .id as string;
    const boProduction = (
      await sql(`SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`, [boHome])
    ).rows[0]!.id as string;

    expect(await snapshot()).toEqual({
      workflows: [
        { id: orgless, org_id: adaHome, active_version_id: v2 },
        { id: bos, org_id: boHome, active_version_id: boV1 },
        { id: ownerless, org_id: null, active_version_id: null },
        { id: chained, org_id: adaHome, active_version_id: null },
        { id: teamFlow, org_id: team, active_version_id: teamV1 },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      pointers: [
        { workflow_id: orgless, environment: 'production', environment_id: env.production, version_id: v2 },
        { workflow_id: orgless, environment: 'qa', environment_id: env.qa, version_id: v1 },
        { workflow_id: bos, environment: 'production', environment_id: boProduction, version_id: boV1 },
        {
          workflow_id: teamFlow,
          environment: 'production',
          environment_id: teamProduction,
          version_id: teamV1,
        },
      ].sort((a, b) => (a.workflow_id < b.workflow_id ? -1 : a.workflow_id > b.workflow_id ? 1 : 0)),
      secrets: [env.production, env.qa, env.uat].sort().map((environment_id) => ({
        workflow_id: orgless,
        environment_id,
        node_id: 'trigger',
        secret: CIPHERTEXT,
      })),
      // Stamped on the first boot, where 028 ran before the move: the runs' workspace is the one their workflow moved to.
      runs: [
        { id: `${ada}:done`, org_id: adaHome },
        { id: `${ada}:parked`, org_id: adaHome },
        { id: 'sub_from_team', org_id: team },
        { id: `${ada}:team-parent`, org_id: team },
        { id: 'sub_before_028', org_id: adaHome },
        { id: 'subsub_before_028', org_id: adaHome },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
    expect(await canaryPasses()).toBe(true);
  });

  it('says each thing it did in a warning, and nothing else', () => {
    const linked = (wf: string, name: string, environment: string, org: string, assigned: string): string =>
      `050 linked workflow ${name} (${wf}) to environment ${environment} of workspace ${org}: each trigger its version there holds starts as the service starts, one that listens as an app's account once the account assigned to that app there serves it, and a run started there takes that environment's accounts (assigned: ${assigned}), an app with none answering 428 until one is assigned`;
    const dropped = (environment: string): string =>
      `050 dropped the ${environment} pointer of workflow Orgless Flow (${orgless}) at version ${v1} (v1 on main): workspace ${adaHome} has no environment of that name, so its webhook and chat URLs under it answer 404; promote that version to an environment it has, or create one, to serve it there`;
    expect([...upgradeLines(firstRun)].sort()).toEqual(
      [
        `044 gave b@example.com (${bo}) a personal workspace of its own, ${boHome}: it had none`,
        `050 moved workflow Orgless Flow (${orgless}) of a@example.com into their personal workspace ${adaHome}, with its 1 unfinished run(s): it is on their dashboard there, and Run, an async start and Test this branch reach it`,
        `050 moved workflow Bo Flow (${bos}) of b@example.com into their personal workspace ${boHome}, with its 0 unfinished run(s): it is on their dashboard there, and Run, an async start and Test this branch reach it`,
        linked(orgless, 'Orgless Flow', 'production', adaHome, 'none'),
        linked(orgless, 'Orgless Flow', 'qa', adaHome, 'slack'),
        linked(bos, 'Bo Flow', 'production', boHome, 'none'),
        dropped('default'),
        dropped('staging'),
        `050 gave the signing secret of trigger trigger in workflow Orgless Flow (${orgless}), which named no environment, to each environment of workspace ${adaHome} without its own (production, qa, uat): a delivery there is checked against it wherever that trigger has Verify signatures on`,
        `050 moved workflow Orgless Flow (${orgless}) out of reach of workspace Team (${team}), whose runs called it 2 time(s): a workflow calls only workflows in its own workspace, so a call from there is refused as not found from now on`,
        `050 moved workflow Chained Flow (${chained}) of a@example.com into their personal workspace ${adaHome}, with its 0 unfinished run(s): it is on their dashboard there, and Run, an async start and Test this branch reach it`,
        `050 moved workflow Chained Flow (${chained}) out of reach of workspace Team (${team}), whose runs called it 1 time(s): a workflow calls only workflows in its own workspace, so a call from there is refused as not found from now on`,
      ].sort(),
    );
  });

  it('a second boot changes nothing and says nothing', async () => {
    const settled = await snapshot();
    expect(upgradeLines(await migrate(databaseUrl))).toEqual([]);
    expect(await snapshot()).toEqual(settled);
  });

  describe('the service on the upgraded database, pg-boss off', () => {
    let app: INestApplication;
    let restoreEnv: () => void;
    let adaSession = '';
    const as = (bearer: string, r: request.Test): request.Test => r.set('Authorization', `Bearer ${bearer}`);
    const signed = (raw: string): string =>
      'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    const hook = (environment: string, raw: string, signature?: string): request.Test => {
      const r = from(app)
        .post(`/api/hooks/${orgless}/${environment}`)
        .set('Content-Type', 'application/json');
      return (signature ? r.set('X-Hub-Signature-256', signature) : r).send(raw);
    };
    const activations = async (): Promise<unknown[]> =>
      (
        await sql(
          `SELECT workflow_id, environment_id, trigger_node_id, kind FROM runtime_trigger_activations ORDER BY 1, 2`,
        )
      ).rows;

    beforeAll(async () => {
      restoreEnv = snapshotEnv();
      app = await bootSsoApp(databaseUrl, { LOCAL_AUTH_ENABLED: 'true', DBOS_ENABLED: 'true' });
      adaSession = (await mintSession(ada, SSO_SECRET_KEY)).token;
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      restoreEnv();
    }, 60_000);

    it('stands up the triggers of each pointer it linked as the service starts, with no sweep, and queues nothing again, nor for a pointer whose version holds no trigger', async () => {
      const boProduction = (
        await sql(`SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`, [boHome])
      ).rows[0]!.id as string;
      const expected = [
        { workflow_id: orgless, environment_id: env.production, trigger_node_id: 'trigger', kind: 'webhook' },
        { workflow_id: orgless, environment_id: env.qa, trigger_node_id: 'trigger', kind: 'webhook' },
        { workflow_id: bos, environment_id: boProduction, trigger_node_id: 'trigger', kind: 'webhook' },
      ].sort((a, b) =>
        `${a.workflow_id}${a.environment_id}` < `${b.workflow_id}${b.environment_id}` ? -1 : 1,
      );
      let rows: unknown[] = [];
      for (let i = 0; i < 100 && rows.length < expected.length; i++) {
        rows = await activations();
        if (rows.length < expected.length) await pause(100);
      }
      expect(rows).toEqual(expected);

      const stood = (
        await sql(`SELECT id, updated_at, materialized::text FROM runtime_trigger_activations ORDER BY id`)
      ).rows;
      const enqueue = jest.spyOn(app.get(TriggerSignalsService), 'enqueue');
      try {
        await app.get(TriggerReconcilerService).reconcileStale();
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        enqueue.mockRestore();
      }
      await app.get(TriggerReconcilerService).reconcile(orgless);
      expect(
        (await sql(`SELECT id, updated_at, materialized::text FROM runtime_trigger_activations ORDER BY id`))
          .rows,
      ).toEqual(stood);
    });

    it('repairs as the service starts an activation left on another version, or standing for no trigger, beside a live one in its environment', async () => {
      const live = async (): Promise<unknown[]> =>
        (
          await sql(
            `SELECT environment_id, trigger_node_id, version_id FROM runtime_trigger_activations WHERE workflow_id = $1 ORDER BY 1, 2`,
            [orgless],
          )
        ).rows;
      const settled = await live();
      const bootRepairs = async (drift: () => Promise<unknown>): Promise<void> => {
        await drift();
        expect(await live()).not.toEqual(settled);
        await app.get(TriggerReconcilerService).reconcileStale();
        let rows: unknown[] = [];
        for (let i = 0; i < 100; i++) {
          rows = await live();
          if (JSON.stringify(rows) === JSON.stringify(settled)) break;
          await pause(100);
        }
        expect(rows).toEqual(settled);
      };

      await bootRepairs(() =>
        sql(
          `UPDATE runtime_trigger_activations SET version_id = $2 WHERE workflow_id = $1 AND environment_id = $3`,
          [orgless, v1, env.production],
        ),
      );
      await bootRepairs(() =>
        sql(
          `INSERT INTO runtime_trigger_activations
           SELECT (jsonb_populate_record(NULL::runtime_trigger_activations,
                     to_jsonb(a) || jsonb_build_object('id', gen_random_uuid(), 'trigger_node_id', 'retired'))).*
             FROM runtime_trigger_activations a WHERE a.workflow_id = $1 AND a.environment_id = $2`,
          [orgless, env.production],
        ),
      );
    });

    it('its owner, signed in, finds it on the dashboard, runs it, starts it and tests a branch of it', async () => {
      const listed = await as(adaSession, from(app).get('/api/workflows')).expect(200);
      expect((listed.body.workflows as Array<{ id: string }>).map((w) => w.id)).toContain(orgless);
      const opened = await as(adaSession, from(app).get(`/api/workflows/${orgless}`)).expect(200);
      expect(opened.body.org_id).toBe(adaHome);

      await as(adaSession, from(app).post('/api/runs/from-ir'))
        .send({ workflow_ir: sayDoc('run'), workflow_id: orgless })
        .expect(201);
      await as(adaSession, from(app).post('/api/runs/async'))
        .send({ workflow_ir: sayDoc('started'), workflow_id: orgless })
        .expect(201);

      await as(adaSession, from(app).post(`/api/workflows/${orgless}/branches`))
        .send({ name: 'change' })
        .expect(201);
      await as(adaSession, from(app).post(`/api/workflows/${orgless}/commit`))
        .send({ workflow_json: hookDoc('changed'), branch: 'change' })
        .expect(201);
      const review = await as(adaSession, from(app).post(`/api/workflows/${orgless}/reviews`))
        .send({ source_branch: 'change', title: 'Change it' })
        .expect(201);
      const tested = await as(
        adaSession,
        from(app).post(`/api/workflows/${orgless}/reviews/${review.body.id}/test`),
      )
        .send({})
        .expect(201);
      expect(tested.body.head.status).toBe('completed');
    });

    it('a key pinned to its owner’s personal workspace reaches it, and a workflow no upgrade could move answers 404', async () => {
      const key = await insertApiKey(db, ada, adaHome, { scopes: ['workflow:read'] });
      await as(key, from(app).get(`/api/workflows/${orgless}`)).expect(200);
      await as(key, from(app).get(`/api/workflows/${ownerless}`)).expect(404);
    });

    it('checks a delivery to each environment it was linked to against its signing secret, and one under a name it dropped answers 404', async () => {
      const raw = JSON.stringify({ title: 'moved' });
      await hook('production', raw).expect(401);
      const fired = await hook('production', raw, signed(raw)).expect(202);
      const onQa = await hook('qa', raw, signed(raw)).expect(202);
      await hook('qa', raw).expect(401);
      for (const gone of ['staging', 'default']) await hook(gone, raw, signed(raw)).expect(404);

      const runOf = async (runId: string): Promise<unknown> =>
        (
          await sql(
            `SELECT org_id, environment_id, workflow_version_id FROM runtime_runs WHERE run_id = $1`,
            [runId],
          )
        ).rows[0];
      expect(await runOf(fired.body.run_id as string)).toEqual({
        org_id: adaHome,
        environment_id: env.production,
        workflow_version_id: v2,
      });
      expect(await runOf(onQa.body.run_id as string)).toEqual({
        org_id: adaHome,
        environment_id: env.qa,
        workflow_version_id: v1,
      });
    });

    it('refuses a call to it from a run in another workspace, as one to a workflow that is not there', async () => {
      const caller = ir([irNode('call', 'orchestr:call_workflow', { workflow_id: orgless })], []);
      const refused = await as(adaSession, from(app).post('/api/runs/from-ir').set('X-Org-Id', team))
        .send({ workflow_ir: caller, workflow_id: teamFlow })
        .expect(400);
      expect(refused.body.detail).toBe(`Sub-workflow "${orgless}" not found or not accessible.`);
    });
  });
});

/** 050 beside a write an earlier release, still serving, makes while the upgrade runs. The file alone, on scratch DBs. */
describe('migration 050 beside a write an earlier release makes (scratch DBs)', () => {
  const waitingOnLock = async (db: Client, pid: number): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
        [pid],
      );
      if (rows.length > 0) return;
      await pause(25);
    }
    throw new Error('050 never waited on a lock');
  };
  const relationsLocked = async (db: Client, pid: number): Promise<string[]> =>
    (
      await db.query<{ relname: string }>(
        `SELECT DISTINCT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = $1 AND l.locktype = 'relation' ORDER BY 1`,
        [pid],
      )
    ).rows.map((r) => r.relname);

  async function scenario(
    test: (s: {
      observer: Client;
      writer: Client;
      migration: Client;
      pid: number;
      workflow: string;
      qa: string;
    }) => Promise<void>,
  ): Promise<void> {
    const url = await createE2eDatabase(ADMIN_URL);
    const observer = new Client({ connectionString: url });
    const writer = new Client({ connectionString: url });
    const migration = new Client({ connectionString: url });
    await Promise.all([observer.connect(), writer.connect(), migration.connect()]);
    try {
      const [owner, home, workflow, version] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await observer.query(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'w@example.com', 'W', now(), now())`,
        [owner],
      );
      await insertPersonalOrgs(observer, { id: home, userId: owner, name: 'W' });
      await observer.query(`INSERT INTO environments (org_id, name, is_prod) VALUES ($1, 'qa', false)`, [
        home,
      ]);
      await insertWorkflow(observer, {
        id: workflow,
        name: 'W',
        userId: owner,
        orgId: null,
        versions: [{ id: version, doc: hookDoc('w') }],
        pointers: { qa: version },
      });
      await observer.query(
        `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret) VALUES ($1, NULL, 'trigger', 'first')`,
        [workflow],
      );
      const qa = (
        await observer.query(`SELECT id FROM environments WHERE org_id = $1 AND name = 'qa'`, [home])
      ).rows[0]!.id as string;
      const pid = (await migration.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      await test({ observer, writer, migration, pid, workflow, qa });
    } finally {
      await Promise.all([observer.end(), writer.end(), migration.end()]);
    }
  }

  it('waits for a rename holding an environment before it touches any pointer, then links the pointer under the name it took', async () => {
    await scenario(async ({ observer, writer, migration, pid, workflow, qa }) => {
      await writer.query('BEGIN');
      await writer.query(`SELECT 1 FROM environments WHERE id = $1 FOR NO KEY UPDATE`, [qa]);
      await writer.query(`UPDATE environments SET name = 'QA' WHERE id = $1`, [qa]);
      const migrating = migration.query(M050).then(
        () => 'landed',
        (err: Error) => err.message,
      );
      await waitingOnLock(observer, pid);
      expect(await relationsLocked(observer, pid)).not.toContain('workflow_env_pointers');
      await writer.query('COMMIT');

      expect(await migrating).toBe('landed');
      expect(
        (
          await observer.query(
            `SELECT environment, environment_id FROM workflow_env_pointers WHERE workflow_id = $1`,
            [workflow],
          )
        ).rows,
      ).toEqual([{ environment: 'QA', environment_id: qa }]);
    });
  });

  it('carries a signing secret rotated while it runs to every environment, never the one it replaced', async () => {
    await scenario(async ({ observer, writer, migration, pid, workflow }) => {
      await writer.query('BEGIN');
      await writer.query(`SELECT 1 FROM workflows WHERE id = $1 FOR KEY SHARE`, [workflow]);
      await writer.query(
        `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret) VALUES ($1, NULL, 'trigger', 'rotated')
         ON CONFLICT (workflow_id, COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'::uuid), node_id)
         DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`,
        [workflow],
      );
      const migrating = migration.query(M050).then(
        () => 'landed',
        (err: Error) => err.message,
      );
      await waitingOnLock(observer, pid);
      await writer.query('COMMIT');

      expect(await migrating).toBe('landed');
      expect(
        (
          await observer.query(
            `SELECT e.name, s.secret FROM webhook_trigger_secrets s LEFT JOIN environments e ON e.id = s.environment_id
              WHERE s.workflow_id = $1 ORDER BY 1`,
            [workflow],
          )
        ).rows,
      ).toEqual([
        { name: 'production', secret: 'rotated' },
        { name: 'qa', secret: 'rotated' },
        { name: 'staging', secret: 'rotated' },
        { name: 'uat', secret: 'rotated' },
      ]);

      const notices: string[] = [];
      migration.on('notice', (n) => notices.push(n.message ?? ''));
      await migration.query(M050);
      expect(notices).toEqual([]);
    });
  });
});
