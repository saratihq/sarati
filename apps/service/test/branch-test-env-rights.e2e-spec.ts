import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { mintSession } from '../src/auth/local/local-session';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const SECRET = 'branch-test-env-rights-secret';

const codeDoc = (msg: string): Record<string, unknown> => ({
  version: '1',
  name: 'Env rights',
  description: '',
  nodes: [
    {
      id: 'trigger',
      name: 'Trigger',
      node_type: 'orchestr:trigger',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
    {
      id: 'code',
      name: 'Compute',
      node_type: 'orchestr:code',
      type_version: 1,
      parameters: { language: 'js', code: `return { msg: '${msg}' };` },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e1',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'code',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

const ROLE_REFUSAL = (env: string): string =>
  `Only owners and admins can test a branch under '${env}' in an organization, the same as promoting to it — test it on Default (your connections)`;

/** "Test this branch" runs unreviewed content on an environment's accounts, so under one it takes the right to promote there. */
describe('a branch test under an environment takes the right to promote there (e2e, sessions + API keys)', () => {
  let app: INestApplication;
  let db: Client;
  const owner = randomUUID();
  const member = randomUUID();
  const orgId = randomUUID();
  const keys = {
    member: 'ork_e2e_envrights_member_deploy_aaaa',
    ownerNoDeploy: 'ork_e2e_envrights_owner_nodeploy_bbb',
    owner: 'ork_e2e_envrights_owner_deploy_cccccc',
  };
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  let asOwner = '';
  let asMember = '';
  let wf = '';
  let review = '';
  let production = '';
  let staging = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const inOrg = (r: request.Test, bearer: string): request.Test =>
    r.set('Authorization', `Bearer ${bearer}`).set('X-Org-Id', orgId);
  const testBranch = (bearer: string, environmentId?: string): request.Test =>
    inOrg(http().post(`/api/workflows/${wf}/reviews/${review}/test`), bearer).send(
      environmentId ? { environment_id: environmentId } : {},
    );
  const reviewRuns = async (): Promise<Array<{ environment_id: string | null }>> =>
    (
      await db.query<{ environment_id: string | null }>(
        `SELECT environment_id FROM runtime_runs WHERE review_id = $1 AND source = 'review_test' ORDER BY started_at`,
        [review],
      )
    ).rows;

  const before = { secret: process.env.SECRET_KEY, clerk: process.env.CLERK_ISSUER };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'envrights-owner@e2e.local', 'Owner', now(), now()),
              ($2, 'envrights-member@e2e.local', 'Member', now(), now())`,
      [owner, member],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Acme', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $1, $3, 'member', now())`,
      [orgId, owner, member],
    );
    for (const [user, key, scopes] of [
      [member, keys.member, ['run:execute', 'workflow:read', 'workflow:deploy']],
      [owner, keys.ownerNoDeploy, ['run:execute', 'workflow:read']],
      [owner, keys.owner, ['run:execute', 'workflow:read', 'workflow:deploy']],
    ] as const) {
      await db.query(
        `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'k', $3, $4, $5::json, now())`,
        [user, orgId, hash(key), key.slice(0, 12), JSON.stringify(scopes)],
      );
    }

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.SECRET_KEY = SECRET;
    asOwner = (await mintSession(owner, SECRET)).token;
    asMember = (await mintSession(member, SECRET)).token;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    wf = (
      await inOrg(http().post('/api/deploy'), asOwner)
        .send({ workflow_json: codeDoc('base') })
        .expect(201)
    ).body.workflow_id as string;
    await inOrg(http().post(`/api/workflows/${wf}/branches`), asMember)
      .send({ name: 'change' })
      .expect(201);
    await inOrg(http().post(`/api/workflows/${wf}/commit`), asMember)
      .send({ workflow_json: codeDoc('changed'), branch: 'change' })
      .expect(201);
    review = (
      await inOrg(http().post(`/api/workflows/${wf}/reviews`), asMember)
        .send({ source_branch: 'change', title: 'Change the output' })
        .expect(201)
    ).body.id as string;
    const envs = (await inOrg(http().get('/api/environments'), asMember).expect(200)).body
      .environments as Array<{ id: string; name: string }>;
    production = envs.find((e) => e.name === 'production')!.id;
    staging = envs.find((e) => e.name === 'staging')!.id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    process.env.DATABASE_URL = ADMIN_URL;
    for (const [key, value] of [
      ['SECRET_KEY', before.secret],
      ['CLERK_ISSUER', before.clerk],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a writer without promote rights is refused under production and staging alike, naming each — nothing runs', async () => {
    const ran = (await reviewRuns()).length;

    for (const [id, name] of [
      [production, 'production'],
      [staging, 'staging'],
    ] as const) {
      const refused = await testBranch(asMember, id).expect(403);
      expect(refused.body).toMatchObject({ detail: ROLE_REFUSAL(name), code: 'promote_not_permitted' });
    }
    const mainHead = await inOrg(http().get(`/api/workflows/${wf}/branches/main/head`), asMember).expect(200);
    const promote = await inOrg(http().post(`/api/workflows/${wf}/promote`), asMember)
      .send({ environment: 'production', version_id: mainHead.body.head.version_id })
      .expect(403);
    expect(promote.body.code).toBe('promote_not_permitted');

    expect(await reviewRuns()).toHaveLength(ran);
  }, 30_000);

  it('the same writer tests on Default, as their own connections', async () => {
    const ran = (await reviewRuns()).length;

    const res = await testBranch(asMember).expect(201);

    expect(res.body).toMatchObject({ verdict: 'green', environment_id: null });
    expect(res.body.regression.changed).toContainEqual(
      expect.objectContaining({ node_id: 'code', path: 'msg', before: 'base', after: 'changed' }),
    );
    expect((await reviewRuns()).slice(ran)).toEqual([{ environment_id: null }, { environment_id: null }]);
  }, 30_000);

  it('an owner, who may promote there, tests under production', async () => {
    const ran = (await reviewRuns()).length;

    const res = await testBranch(asOwner, production).expect(201);

    expect(res.body).toMatchObject({ verdict: 'green', environment_id: production });
    expect((await reviewRuns()).slice(ran)).toEqual([
      { environment_id: production },
      { environment_id: production },
    ]);
  }, 30_000);

  it("a member's key is refused under production for the role, and runs on Default", async () => {
    const ran = (await reviewRuns()).length;

    const refused = await testBranch(keys.member, production).expect(403);
    expect(refused.body).toMatchObject({ detail: ROLE_REFUSAL('production'), code: 'promote_not_permitted' });
    expect(await reviewRuns()).toHaveLength(ran);

    const res = await testBranch(keys.member).expect(201);
    expect(res.body).toMatchObject({ verdict: 'green', environment_id: null });
  }, 30_000);

  it('an owner\'s key without "workflow:deploy" is refused under production naming the scope, and runs on Default', async () => {
    const ran = (await reviewRuns()).length;

    const refused = await testBranch(keys.ownerNoDeploy, production).expect(403);
    expect(refused.body).toMatchObject({
      detail:
        'This API key is missing the "workflow:deploy" scope it takes to test a branch under \'production\', the same as promoting to it — test it on Default (your connections)',
      code: 'promote_not_permitted',
    });
    expect(await reviewRuns()).toHaveLength(ran);

    const res = await testBranch(keys.ownerNoDeploy).expect(201);
    expect(res.body).toMatchObject({ verdict: 'green', environment_id: null });
  }, 30_000);

  it('an owner\'s key holding "workflow:deploy" tests under production', async () => {
    const ran = (await reviewRuns()).length;

    const res = await testBranch(keys.owner, production).expect(201);

    expect(res.body).toMatchObject({ verdict: 'green', environment_id: production });
    expect((await reviewRuns()).slice(ran)).toEqual([
      { environment_id: production },
      { environment_id: production },
    ]);
  }, 30_000);
});
