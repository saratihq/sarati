import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Two managed Gmail accounts: the author's personal one and the staging slot's. */
const CA_PERSONAL = 'ca_env_personal';
const CA_STAGING = 'ca_env_staging';

/** A gmail-connection step behind a canvas webhook trigger node (ADR 0018) — the rebind subject. */
function gmailIr(connectionId: string): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'env slot flow',
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
        id: 'profile',
        name: 'Profile',
        node_type: 'gmail.get_profile',
        type_version: 1,
        parameters: { connectionId },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-profile',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'profile',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** ADR 0014 — environments as first-class rows, end to end against a stubbed Composio transport. */
describe('environments (e2e, isolated DB, org owner + member via API keys, stubbed Composio)', () => {
  let app: INestApplication;
  let db: Client;
  let composioStub: Server;
  /** Every typed tools/execute call the stub received (connected_account_id proves the rebind). */
  let toolCalls: Array<{ tool: string; payload: Record<string, unknown> }> = [];

  const userA = randomUUID(); // org owner
  const userB = randomUUID(); // plain org member
  const personalA = randomUUID();
  const personalB = randomUUID();
  const keyA = 'ork_e2e_envown_aaaaaaaaaaaaaaaaaaaaaaaa';
  const keyB = 'ork_e2e_envmem_bbbbbbbbbbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let prodId = '';
  let stagingId = '';
  let uatId = '';
  let qaId = ''; // created in the CRUD test, renamed to qa2
  let c1 = ''; // owner token connection (slack)
  let c2 = ''; // owner token connection (slack), ends up slotted + force-deleted
  let cb = ''; // member token connection — invisible to the owner
  let wfId = ''; // slack workflow (references test)
  let gmailWfId = ''; // gmail workflow (crown jewel)
  let personalConnId = ''; // managed gmail — the author's pool account
  let slotConnId = ''; // managed gmail — assigned to staging's slot
  let envHookPath = ''; // /api/hooks/<gmailWf>/staging — the staging-pinned fire URL

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const asB = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyB}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'env-owner-a@e2e.local', 'Env Owner A', now(), now()),
              ($2, 'env-member-b@e2e.local', 'Env Member B', now(), now())`,
      [userA, userB],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Env Owner A', true, now(), now()),
              ($2, 'Env Member B', true, now(), now())`,
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

    // Stubbed Composio: typed execution + account status — no real network.
    composioStub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = req.url ?? '';
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'GET' && url.startsWith('/api/v3/tools?')) {
          json(200, {
            items: [{ slug: 'GMAIL_GET_PROFILE', name: 'Get profile', input_parameters: { properties: {} } }],
            next_cursor: null,
          });
          return;
        }
        const typed = /^\/api\/v3\/tools\/execute\/([A-Z0-9_]+)$/.exec(url);
        if (req.method === 'POST' && typed) {
          toolCalls.push({ tool: typed[1]!, payload: JSON.parse(raw) as Record<string, unknown> });
          json(200, {
            successful: true,
            data: { response_data: { emailAddress: 'x@e2e.local' } },
            error: null,
          });
          return;
        }
        if (req.method === 'GET' && /^\/api\/v3\/connected_accounts\/ca_env_/.test(url)) {
          json(200, { id: url.split('/').pop(), status: 'ACTIVE', state: { val: {} } });
          return;
        }
        json(404, { error: `unexpected ${req.method} ${url}` });
      });
    });
    await new Promise<void>((resolve) => composioStub.listen(0, '127.0.0.1', resolve));

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composioStub.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    const org = await asA(http().post('/api/orgs').send({ name: 'Acme Envs' })).expect(201);
    orgId = org.body.id as string;
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
      [orgId, userB],
    );
    // The managed rail's key lives in the store, per scope — seeded AFTER the org exists.
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => composioStub.close(resolve));
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_BASE_URL;
  });

  /** Poll a fire-and-forget run until it settles in run history. */
  async function awaitRun(runId: string): Promise<Record<string, unknown>> {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      const res = await asA(http().get(`/api/runs/${runId}`)).expect(200);
      run = res.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return run;
  }

  async function listEnvs(): Promise<Array<Record<string, unknown>>> {
    const res = await asA(http().get('/api/environments').set('X-Org-Id', orgId)).expect(200);
    return res.body.environments as Array<Record<string, unknown>>;
  }

  it('lazy defaults: the first list ensures prod (is_prod anchor) + staging + uat; members may read', async () => {
    const envs = await listEnvs();
    expect(envs.map((e) => [e.name, e.is_prod])).toEqual([
      ['production', true], // is_prod first
      ['staging', false],
      ['uat', false],
    ]);
    for (const env of envs) {
      expect(env).toMatchObject({ slots: [], pointer_count: 0, trigger_count: 0 });
      expect(env.id).toEqual(expect.any(String));
    }
    prodId = envs[0]!.id as string;
    stagingId = envs[1]!.id as string;
    uatId = envs[2]!.id as string;

    // A plain member may READ (guard-validated membership is the gate)…
    await asB(http().get('/api/environments').set('X-Org-Id', orgId)).expect(200);
    // …and a non-member org id is a 403 at the guard.
    await asB(http().get('/api/environments').set('X-Org-Id', randomUUID())).expect(403);
  });

  it('personal workspaces get the identical surface (no X-Org-Id → the personal org)', async () => {
    const res = await asA(http().get('/api/environments')).expect(200);
    const personal = res.body.environments as Array<Record<string, unknown>>;
    expect(personal.map((e) => e.name)).toEqual(['production', 'staging', 'uat']);
    // A different id space from Acme's rows — environments are org-scoped.
    expect(personal.map((e) => e.id)).not.toContain(prodId);
    // The personal org's owner is the user → curation writes pass.
    const created = await asA(http().post('/api/environments').send({ name: 'sandbox' })).expect(201);
    await asA(http().delete(`/api/environments/${created.body.id}`)).expect(200);
  });

  it('env CRUD: owner/admin-gated, lowercased, case-insensitively unique; is_prod is anchored', async () => {
    await asB(http().post('/api/environments').set('X-Org-Id', orgId).send({ name: 'qa' })).expect(403);

    // Create lowercases (one vocabulary with pointers/triggers/tags).
    const qa = await asA(http().post('/api/environments').set('X-Org-Id', orgId).send({ name: 'QA' })).expect(
      201,
    );
    expect(qa.body).toEqual({ id: expect.any(String), name: 'qa' });
    qaId = qa.body.id as string;

    // Case-insensitive uniqueness, reserved + malformed names.
    await asA(http().post('/api/environments').set('X-Org-Id', orgId).send({ name: 'qa' })).expect(409);
    await asA(http().post('/api/environments').set('X-Org-Id', orgId).send({ name: 'Qa' })).expect(409);
    await asA(http().post('/api/environments').set('X-Org-Id', orgId).send({ name: 'default' })).expect(400);
    await asA(http().post('/api/environments').set('X-Org-Id', orgId).send({ name: 'bad.env' })).expect(400);

    // Rename: is_prod is non-renamable; duplicates refused; a clean rename lands.
    await asA(
      http().patch(`/api/environments/${prodId}`).set('X-Org-Id', orgId).send({ name: 'production' }),
    ).expect(409);
    await asA(http().patch(`/api/environments/${qaId}`).set('X-Org-Id', orgId).send({ name: 'uat' })).expect(
      409,
    );
    const renamed = await asA(
      http().patch(`/api/environments/${qaId}`).set('X-Org-Id', orgId).send({ name: 'qa2' }),
    ).expect(200);
    expect(renamed.body).toEqual({ id: qaId, name: 'qa2' });

    // uat is predefined like prod: locked name, undeletable.
    await asA(
      http().patch(`/api/environments/${uatId}`).set('X-Org-Id', orgId).send({ name: 'acceptance' }),
    ).expect(409);
    await asA(http().delete(`/api/environments/${uatId}`).set('X-Org-Id', orgId)).expect(409);

    // Delete: is_prod is non-deletable; members can't delete; foreign ids are 404.
    await asA(http().delete(`/api/environments/${prodId}`).set('X-Org-Id', orgId)).expect(409);
    await asB(http().delete(`/api/environments/${qaId}`).set('X-Org-Id', orgId)).expect(403);
    await asA(http().delete(`/api/environments/${randomUUID()}`).set('X-Org-Id', orgId)).expect(404);
  });

  it('slots: assign/replace/empty as references, with the also-serving warning and ownership checks', async () => {
    const mk = async (key: request.Test): Promise<string> => {
      const res = await key.expect(201);
      return res.body.id as string;
    };
    c1 = await mk(asA(http().post('/api/connections').send({ provider: 'slack', credential: 't1' })));
    c2 = await mk(asA(http().post('/api/connections').send({ provider: 'slack', credential: 't2' })));
    cb = await mk(asB(http().post('/api/connections').send({ provider: 'slack', credential: 'tb' })));

    // First assignment fills an empty slot.
    const first = await asA(
      http()
        .put(`/api/environments/${stagingId}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: c1 }),
    ).expect(200);
    expect(first.body).toEqual({ replaced_connection_id: null, also_in_environments: [] });

    // The list renders the slot: account + owner identity + health.
    const staging = (await listEnvs()).find((e) => e.id === stagingId)!;
    expect(staging.slots).toEqual([
      {
        app: 'slack',
        connection_id: c1,
        account_label: 'slack', // token row without display_name → provider fallback
        owner_user_id: userA,
        owner_label: 'env-owner-a@e2e.local',
        status: 'active',
      },
    ]);

    // Replace names what was replaced; re-assigning the same account replaces nothing.
    const replaced = await asA(
      http()
        .put(`/api/environments/${stagingId}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: c2 }),
    ).expect(200);
    expect(replaced.body).toEqual({ replaced_connection_id: c1, also_in_environments: [] });
    const same = await asA(
      http()
        .put(`/api/environments/${stagingId}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: c2 }),
    ).expect(200);
    expect(same.body).toEqual({ replaced_connection_id: null, also_in_environments: [] });

    // The same account serving another env is named (the data-safety warning).
    const alsoProd = await asA(
      http()
        .put(`/api/environments/${prodId}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: c2 }),
    ).expect(200);
    expect(alsoProd.body).toEqual({ replaced_connection_id: null, also_in_environments: ['staging'] });

    // Assignment never mutates the pool row — it stays in the owner's flat list.
    const pool = await asA(http().get('/api/connections')).expect(200);
    expect((pool.body as Array<{ id: string }>).map((c) => c.id)).toEqual(expect.arrayContaining([c1, c2]));

    // A foreign connection must be an indistinguishable 404, never a 403.
    await asB(
      http()
        .put(`/api/environments/${stagingId}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: cb }),
    ).expect(403);
    await asA(
      http()
        .put(`/api/environments/${stagingId}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: cb }),
    ).expect(404);
    await asA(
      http()
        .put(`/api/environments/${stagingId}/slots/Bad.App`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: c1 }),
    ).expect(400);
    await asA(
      http()
        .put(`/api/environments/${randomUUID()}/slots/slack`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: c1 }),
    ).expect(404);

    // Empty the staging slot; a second empty is an honest 404.
    const emptied = await asA(
      http().delete(`/api/environments/${stagingId}/slots/slack`).set('X-Org-Id', orgId),
    ).expect(200);
    expect(emptied.body).toEqual({ removed: true });
    await asA(http().delete(`/api/environments/${stagingId}/slots/slack`).set('X-Org-Id', orgId)).expect(404);
  });

  it('connection references + delete: 409 with the payload, force cascades the slots away', async () => {
    // c2 fills prod/slack (from above) + uat/slack; a deployed workflow gives prod a pointer.
    await asA(
      http().put(`/api/environments/${uatId}/slots/slack`).set('X-Org-Id', orgId).send({ connection_id: c2 }),
    ).expect(200);
    const dep = await asA(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({ workflow_json: gmailIr(randomUUID()) }),
    ).expect(201);
    wfId = dep.body.workflow_id as string;

    const refs = await asA(http().get(`/api/connections/${c2}/references`)).expect(200);
    expect(refs.body).toEqual({
      references: [
        { environment_id: prodId, environment: 'production', workflows_affected: 1 },
        { environment_id: uatId, environment: 'uat', workflows_affected: 0 },
      ],
    });
    // A foreign caller can't even see the references (indistinguishable 404).
    await asB(http().get(`/api/connections/${c2}/references`)).expect(404);

    // Delete refuses with the references payload TOP-LEVEL next to detail…
    const blocked = await asA(http().delete(`/api/connections/${c2}`)).expect(409);
    expect(blocked.body.detail).toMatch(/assigned to environment slots/i);
    expect(blocked.body.references).toEqual(refs.body.references);

    // …and force removes it, cascading its slot rows away.
    const forced = await asA(http().delete(`/api/connections/${c2}?force=true`)).expect(200);
    expect(forced.body).toEqual({ status: 'deleted' });
    const envs = await listEnvs();
    expect(envs.find((e) => e.id === prodId)!.slots).toEqual([]);
    expect(envs.find((e) => e.id === uatId)!.slots).toEqual([]);
    const noRefs = await asA(http().get(`/api/connections/${c1}/references`)).expect(200);
    expect(noRefs.body).toEqual({ references: [] });
  });

  it('THE CROWN JEWEL: an env-scoped fire resolves the step through the SLOT; Default stays personal; an emptied slot fails honestly', async () => {
    // Two managed gmail accounts: the author's pool account and the slot's.
    const connections = app.get(ConnectionsService);
    personalConnId = (await connections.createManaged(userA, 'gmail', CA_PERSONAL)).id;
    await connections.setStatus(personalConnId, 'active');
    slotConnId = (await connections.createManaged(userA, 'gmail', CA_STAGING)).id;
    await connections.setStatus(slotConnId, 'active');

    // The workflow's step references the PERSONAL connection.
    const dep = await asA(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({ workflow_json: gmailIr(personalConnId) }),
    ).expect(201);
    gmailWfId = dep.body.workflow_id as string;
    const versions = await asA(
      http().get(`/api/workflows/${gmailWfId}/versions`).set('X-Org-Id', orgId),
    ).expect(200);
    const v1 = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!;
    await asA(
      http()
        .post(`/api/workflows/${gmailWfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'staging', version_id: v1.id }),
    ).expect(201);
    await asA(
      http()
        .put(`/api/environments/${stagingId}/slots/gmail`)
        .set('X-Org-Id', orgId)
        .send({ connection_id: slotConnId }),
    ).expect(200);

    // Canvas triggers (ADR 0018): the webhook node lives in the version doc — no trigger row.
    envHookPath = `/api/hooks/${gmailWfId}/staging`;

    // ENV-SCOPED FIRE → the step must execute on the SLOT's account, AS its owner.
    toolCalls = [];
    const envFire = await http().post(envHookPath).send({}).expect(202);
    const envRun = await awaitRun(envFire.body.run_id as string);
    expect(envRun.status).toBe('completed');
    expect(envRun.environment).toBe('staging');
    expect(envRun.environment_id).toBe(stagingId);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.payload.connected_account_id).toBe(CA_STAGING);
    expect(toolCalls[0]?.payload.user_id).toBe(userA); // runs AS the slot connection's owner

    // EMPTIED SLOT → the env fire fails honestly (never falls back to the pool).
    await asA(http().delete(`/api/environments/${stagingId}/slots/gmail`).set('X-Org-Id', orgId)).expect(200);
    toolCalls = [];
    const brokenFire = await http().post(envHookPath).send({}).expect(202);
    const brokenRun = await awaitRun(brokenFire.body.run_id as string);
    expect(brokenRun.status).toBe('error');
    expect(String(brokenRun.error)).toMatch(/No "gmail" connection in the staging environment/i);
    expect(toolCalls).toHaveLength(0); // nothing executed anywhere
  }, 30_000);

  it('pointer removal: un-promote by environment_id (member 403; prod allowed and goes dark)', async () => {
    // staging (from the crown-jewel test) — a member may not un-promote a non-prod env.
    await asB(
      http().delete(`/api/workflows/${gmailWfId}/pointers/${stagingId}`).set('X-Org-Id', orgId),
    ).expect(403);
    const removed = await asA(
      http().delete(`/api/workflows/${gmailWfId}/pointers/${stagingId}`).set('X-Org-Id', orgId),
    ).expect(200);
    expect(removed.body).toEqual({ removed: true, environment: 'staging' });
    // Idempotence is NOT silent: a second removal says there is nothing there.
    await asA(
      http().delete(`/api/workflows/${gmailWfId}/pointers/${stagingId}`).set('X-Org-Id', orgId),
    ).expect(404);

    // The staging webhook URL is now inert (no pointer → the intake 404s up front).
    await http().post(envHookPath).send({}).expect(404);

    // PROD removal is allowed and goes DARK: the pointer row AND the legacy alias are cleared.
    const prodRemoved = await asA(
      http().delete(`/api/workflows/${gmailWfId}/pointers/${prodId}`).set('X-Org-Id', orgId),
    ).expect(200);
    expect(prodRemoved.body).toEqual({ removed: true, environment: 'production' });
    const alias = await db.query(`SELECT active_version_id FROM workflows WHERE id = $1`, [gmailWfId]);
    expect(alias.rows[0]).toEqual({ active_version_id: null });
    const pointers = await db.query(`SELECT 1 FROM workflow_env_pointers WHERE workflow_id = $1`, [
      gmailWfId,
    ]);
    expect(pointers.rows).toHaveLength(0);

    // Prod dark → its webhook URL is inert too.
    await http().post(`/api/hooks/${gmailWfId}/production`).send({}).expect(404);
  }, 30_000);

  it('env delete: cascades its pointers AND its trigger activations, with the receipt', async () => {
    // qa2 gets a pointer + a materialized webhook activation (ADR 0018), then dies.
    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    const v1 = (versions.body.versions as Array<{ id: string; version_number: number }>)[0]!;
    await asA(
      http()
        .post(`/api/workflows/${wfId}/promote`)
        .set('X-Org-Id', orgId)
        .send({ environment: 'qa2', version_id: v1.id }),
    ).expect(201);
    // Reconcile materializes the webhook activation from the pointed version's trigger node.
    await app.get(TriggerReconcilerService).reconcile(wfId);
    const activations = await db.query(
      `SELECT id FROM runtime_trigger_activations WHERE workflow_id = $1 AND environment_id = $2`,
      [wfId, qaId],
    );
    expect(activations.rows).toHaveLength(1);

    const beforeDelete = (await listEnvs()).find((e) => e.id === qaId)!;
    expect(beforeDelete).toMatchObject({ pointer_count: 1, trigger_count: 1 });

    const receipt = await asA(http().delete(`/api/environments/${qaId}`).set('X-Org-Id', orgId)).expect(200);
    expect(receipt.body).toEqual({ removed_pointers: 1, unbound_triggers: 1 });

    // The activation died with the env (FK CASCADE); the pointer is gone too.
    const remaining = await db.query(
      `SELECT 1 FROM runtime_trigger_activations WHERE workflow_id = $1 AND environment_id = $2`,
      [wfId, qaId],
    );
    expect(remaining.rows).toHaveLength(0);
    const pointers = await db.query(
      `SELECT environment FROM workflow_env_pointers WHERE workflow_id = $1 ORDER BY environment`,
      [wfId],
    );
    expect(pointers.rows).toEqual([{ environment: 'production' }]); // qa2's row died with it
  });
});
