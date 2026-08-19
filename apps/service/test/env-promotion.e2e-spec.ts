import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A canvas webhook trigger feeding an announce step whose output proves WHICH version ran. */
function irDoc(prefix: string): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'promotion target',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'On incoming webhook',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: [`${prefix}: `, '{{trigger.title}}'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-announce',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** Per-environment live pointers: prod runs v1 while staging runs v2 of the SAME workflow. */
describe('env promotion (e2e, isolated DB, org owner + member via API keys)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID(); // org owner
  const userB = randomUUID(); // plain org member
  const personalA = randomUUID();
  const personalB = randomUUID();
  const keyA = 'ork_e2e_owner_aaaaaaaaaaaaaaaaaaaaaaaa';
  const keyB = 'ork_e2e_member_bbbbbbbbbbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';
  let v1Id = '';
  let v2Id = '';
  let prodHookPath = ''; // /api/hooks/<wf>/production — fires the prod-pinned version
  let stagingHookPath = ''; // /api/hooks/<wf>/staging — fires the staging-pinned version

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const asB = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyB}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-a@e2e.local', 'Owner A', now(), now()),
              ($2, 'member-b@e2e.local', 'Member B', now(), now())`,
      [userA, userB],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner A', true, now(), now()),
              ($2, 'Member B', true, now(), now())`,
      [personalA, personalB],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()),
              (gen_random_uuid(), $3, $4, 'owner', now())`,
      [personalA, userA, personalB, userB],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, now()),
              (gen_random_uuid(), $4, 'b', $5, $6, now())`,
      [userA, hash(keyA), keyA.slice(0, 12), userB, hash(keyB), keyB.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    // Org "Acme": A owns it; B is a plain member (role gate subject).
    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
      [orgId, userB],
    );
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  /** Poll a fire-and-forget run until it settles in run history. */
  async function awaitRun(runId: string): Promise<Record<string, unknown>> {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const res = await asA(http().get(`/api/runs/${runId}`)).expect(200);
      run = res.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return run;
  }

  /** Fire a webhook trigger and return the settled run. */
  async function fire(hookPath: string, title: string): Promise<Record<string, unknown>> {
    const fired = await http().post(hookPath).send({ title }).expect(202);
    return awaitRun(fired.body.run_id as string);
  }

  async function envPointers(): Promise<Array<Record<string, unknown>>> {
    const res = await asA(http().get(`/api/workflows/${wfId}`).set('X-Org-Id', orgId)).expect(200);
    return res.body.env_pointers as Array<Record<string, unknown>>;
  }

  it('create publishes v1: the prod pointer row exists and detail lists it', async () => {
    const deployed = await asA(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({ workflow_json: irDoc('v1') }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;
    // Canvas triggers: the fire URL is per-`(workflow, env)` and version-independent.
    prodHookPath = `/api/hooks/${wfId}/production`;
    stagingHookPath = `/api/hooks/${wfId}/staging`;

    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    v1Id = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!.id;

    // The create-time pointer row (not just the legacy alias).
    const rows = await db.query(
      `SELECT environment, version_id FROM workflow_env_pointers WHERE workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toEqual([{ environment: 'production', version_id: v1Id }]);
    expect(await envPointers()).toEqual([{ environment: 'production', version_id: v1Id, version_number: 1 }]);
    // The versions list carries the same pointers (env badges' data source).
    expect(versions.body.env_pointers).toEqual([
      { environment: 'production', version_id: v1Id, version_number: 1 },
    ]);
  });

  it('the prod webhook URL is live (prod is pinned to v1); the staging URL is dark until promoted', async () => {
    // Prod points at v1 (the create-time publish), so its per-env URL fires.
    const run = await fire(prodHookPath, 'prod live');
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('v1: prod live');

    // With no staging pointer the intake is inert: 404 up front, and nothing is ever enqueued.
    const runsBefore = await db.query(`SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1`, [
      wfId,
    ]);
    await http().post(stagingHookPath).send({ title: 'too early' }).expect(404);
    const runsAfter = await db.query(`SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1`, [
      wfId,
    ]);
    expect(runsAfter.rows[0].n).toBe(runsBefore.rows[0].n);
  });

  it('THE PROOF (1/3): after saving v2, prod still points at v1 — the prod trigger fires v1', async () => {
    await asA(
      http()
        .post(`/api/workflows/${wfId}/commit`)
        .set('X-Org-Id', orgId)
        // An API key must name the head it edited from — sessions are unaffected.
        .send({ workflow_ir: irDoc('v2'), commit_message: 'v2', base_version_id: v1Id }),
    ).expect(201);
    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    v2Id = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 2,
    )!.id;

    const run = await fire(prodHookPath, 'after save');
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('v1: after save'); // Save ≠ Live
  });

  it('THE PROOF (2/3): promote staging→v2 — the staging trigger fires v2 while prod still fires v1', async () => {
    const promoted = await asA(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'staging', version_id: v2Id }),
    ).expect(201);
    expect(promoted.body).toEqual({
      status: 'promoted',
      workflow_id: wfId,
      environment: 'staging',
      version_id: v2Id,
      version_number: 2,
      previous_version_number: null,
    });

    const stagingRun = await fire(stagingHookPath, 'split brain');
    expect(stagingRun.status).toBe('completed');
    expect((stagingRun.outputs as Record<string, unknown>).announce).toBe('v2: split brain');
    // The run records which env + exact version it executed.
    expect(stagingRun.environment).toBe('staging');
    expect(stagingRun.workflow_version_id).toBe(v2Id);

    const prodRun = await fire(prodHookPath, 'split brain');
    expect((prodRun.outputs as Record<string, unknown>).announce).toBe('v1: split brain');
    expect(prodRun.environment).toBe('production'); // explicitly prod-scoped since W1 (unscoped = Default = head)
    expect(prodRun.workflow_version_id).toBe(v1Id);

    // The runs LIST resolves the human version number alongside the raw id.
    const runList = await asA(http().get(`/api/runs?workflow_id=${wfId}`)).expect(200);
    const listedStaging = (runList.body.runs as Array<Record<string, unknown>>).find(
      (r) => r.run_id === stagingRun.run_id,
    );
    expect(listedStaging?.version_number).toBe(2);

    // Detail shows both pointers, prod first; the dashboard list gets its chip.
    expect(await envPointers()).toEqual([
      { environment: 'production', version_id: v1Id, version_number: 1 },
      { environment: 'staging', version_id: v2Id, version_number: 2 },
    ]);
    const list = await asA(http().get('/api/workflows').set('X-Org-Id', orgId)).expect(200);
    const summary = (list.body.workflows as Array<{ id: string; environments: string[] }>).find(
      (w) => w.id === wfId,
    );
    expect(summary?.environments).toEqual(['staging']);
  });

  it('THE PROOF (3/3): promote prod→v2 through the UNCHANGED publish contract — prod now fires v2', async () => {
    const pub = await asA(
      http().post(`/api/workflows/${wfId}/publish`).set('X-Org-Id', orgId).send({}),
    ).expect(201);
    expect(pub.body).toEqual({ status: 'published', workflow_id: wfId, live_version: 2 }); // parity

    // Publish moved the POINTER row (not just the alias) — publish IS promote-to-prod.
    const rows = await db.query(
      `SELECT version_id FROM workflow_env_pointers WHERE workflow_id = $1 AND environment = 'production'`,
      [wfId],
    );
    expect(rows.rows).toEqual([{ version_id: v2Id }]);

    const run = await fire(prodHookPath, 'after promote');
    expect((run.outputs as Record<string, unknown>).announce).toBe('v2: after promote');
  });

  it('restore keeps prod semantics: prod rolls back to v1, staging is untouched', async () => {
    const res = await asA(
      http().post(`/api/workflows/${wfId}/restore`).set('X-Org-Id', orgId).send({ version_number: 1 }),
    ).expect(201);
    expect(res.body).toEqual({ status: 'restored', workflow_id: wfId, live_version: 1 });

    expect(await envPointers()).toEqual([
      { environment: 'production', version_id: v1Id, version_number: 1 },
      { environment: 'staging', version_id: v2Id, version_number: 2 },
    ]);
    const run = await fire(prodHookPath, 'after restore');
    expect((run.outputs as Record<string, unknown>).announce).toBe('v1: after restore');
  });

  it('promote is idempotent: re-pointing the same version emits no second event', async () => {
    const countPromoted = async (): Promise<number> => {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM domain_events
          WHERE subject_id = $1 AND type = 'workflow.promoted'
            AND payload->>'environment' = 'staging'`,
        [wfId],
      );
      return r.rows[0].n as number;
    };
    const before = await countPromoted();
    const again = await asA(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'staging', version_id: v2Id }),
    ).expect(201);
    expect(again.body).toMatchObject({ status: 'promoted', version_number: 2, previous_version_number: 2 });
    expect(await countPromoted()).toBe(before);
  });

  it('gates (B3): a member 403s EVERY org env pointer move — staging AND prod (promote + publish); owner passes; bad env/version rejected', async () => {
    // Mirror — a plain member cannot point an org env.
    const denied = await asB(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'staging', version_id: v1Id }),
    ).expect(403);
    expect(String(denied.body.detail)).toMatch(/owners and admins/i);

    // (B3) PRODUCTION is not exempt, and publish/restore funnel through the same gate.
    const deniedProd = await asB(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'production', version_id: v1Id }),
    ).expect(403);
    expect(String(deniedProd.body.detail)).toMatch(/owners and admins/i);
    await asB(http().post(`/api/workflows/${wfId}/publish`).set('X-Org-Id', orgId).send({})).expect(403);

    // An owner/admin still can — the capability moved, it was not removed.
    await asA(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'production', version_id: v1Id }),
    ).expect(201);

    // Malformed environment / foreign version / unknown workflow.
    await asA(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'bad.env', version_id: v1Id }),
    ).expect(400);
    await asA(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'staging', version_id: randomUUID() }),
    ).expect(404);
    await asA(
      http()
        .post(`/api/workflows/${randomUUID()}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'staging', version_id: v1Id }),
    ).expect(404);
  });
});
