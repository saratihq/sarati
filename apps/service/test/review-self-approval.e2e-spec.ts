import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

const ir = (name: string): Record<string, unknown> => ({
  version: '1',
  name,
  description: '',
  nodes: [
    {
      id: 'trigger',
      name,
      node_type: 'orchestr:trigger',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
  ],
  edges: [],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/**
 * A protected branch's review gate is only worth something if the author cannot satisfy it alone —
 * but a workspace with nobody else to ask must not deadlock. Both halves are asserted here.
 */
describe('self-approval (e2e, isolated DB, two real users)', () => {
  let app: INestApplication;
  let db: Client;
  const owner = randomUUID();
  const member = randomUUID();
  const soloUser = randomUUID();
  const orgId = randomUUID();
  const personalOwner = randomUUID();
  const personalMember = randomUUID();
  const personalSolo = randomUUID();
  const keyOwner = 'ork_e2e_selfapp_owner_aaaaaaaaaaaa';
  const keyMember = 'ork_e2e_selfapp_member_bbbbbbbbbb';
  const keySolo = 'ork_e2e_selfapp_solo_cccccccccccc';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const asOwner = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyOwner}`);
  const asMember = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyMember}`);
  const asSolo = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keySolo}`);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'sa-owner@e2e.local', 'Owner', now(), now()),
              ($2, 'sa-member@e2e.local', 'Member', now(), now()),
              ($3, 'sa-solo@e2e.local', 'Solo', now(), now())`,
      [owner, member, soloUser],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner', true, now(), now()),
              ($2, 'Member', true, now(), now()),
              ($3, 'Solo', true, now(), now()),
              ($4, 'Acme', false, now(), now())`,
      [personalOwner, personalMember, personalSolo, orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()),
              (gen_random_uuid(), $3, $4, 'owner', now()),
              (gen_random_uuid(), $5, $6, 'owner', now()),
              (gen_random_uuid(), $7, $2, 'owner', now()),
              (gen_random_uuid(), $7, $4, 'member', now())`,
      [personalOwner, owner, personalMember, member, personalSolo, soloUser, orgId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'o', $2, $3, now()),
              (gen_random_uuid(), $4, 'm', $5, $6, now()),
              (gen_random_uuid(), $7, 's', $8, $9, now())`,
      [
        owner,
        hash(keyOwner),
        keyOwner.slice(0, 12),
        member,
        hash(keyMember),
        keyMember.slice(0, 12),
        soloUser,
        hash(keySolo),
        keySolo.slice(0, 12),
      ],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  /** A workflow on `orgHeader`'s org with a branch carrying one commit, and an open review into main. */
  async function openReview(
    act: (r: request.Test) => request.Test,
    orgHeader: string | null,
    name: string,
  ): Promise<{ workflowId: string; reviewId: string }> {
    const org = (r: request.Test): request.Test => (orgHeader ? r.set('X-Org-Id', orgHeader) : r);
    const created = await org(
      act(
        http()
          .post('/api/deploy')
          .send({ workflow_json: ir(name) }),
      ),
    ).expect(201);
    const workflowId = created.body.workflow_id as string;
    await org(act(http().post(`/api/workflows/${workflowId}/branches`).send({ name: 'change' }))).expect(201);
    // An api_key principal must pin the head it edited (ADR 0052), so read it first.
    const head = await org(act(http().get(`/api/workflows/${workflowId}/branches/change/head`))).expect(200);
    await org(
      act(
        http()
          .post(`/api/workflows/${workflowId}/commit`)
          .send({
            workflow_ir: ir(`${name} edited`),
            branch: 'change',
            base_version_id: head.body.head.version_id,
          }),
      ),
    ).expect(201);
    const review = await org(
      act(
        http()
          .post(`/api/workflows/${workflowId}/reviews`)
          .send({ source_branch: 'change', target_branch: 'main', title: `${name} review` }),
      ),
    ).expect(201);
    return { workflowId, reviewId: review.body.id as string };
  }

  it('the author cannot approve their own review when someone else could', async () => {
    const { workflowId, reviewId } = await openReview(asMember, orgId, 'member change');

    const refused = await asMember(
      http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/approve`).set('X-Org-Id', orgId),
    )
      .send({ decision: 'approved' })
      .expect(409);
    expect(refused.body.code).toBe('self_approval_blocked');

    // …and the unapproved review cannot then be merged into a protected main.
    await asOwner(
      http().patch(`/api/workflows/${workflowId}/branches/main/protection`).set('X-Org-Id', orgId),
    )
      .send({ is_protected: true })
      .expect(200);
    await asMember(
      http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/merge`).set('X-Org-Id', orgId),
    )
      .send({})
      .expect(400);

    // A teammate's approval is what opens it.
    await asOwner(
      http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/approve`).set('X-Org-Id', orgId),
    )
      .send({ decision: 'approved' })
      .expect(201);
    const merged = await asMember(
      http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/merge`).set('X-Org-Id', orgId),
    )
      .send({})
      .expect(201);
    expect(merged.body.status).toBe('merged');
  });

  it('rejecting your own review is still allowed — only approval is the conflict', async () => {
    const { workflowId, reviewId } = await openReview(asMember, orgId, 'member withdraw');
    await asMember(
      http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/approve`).set('X-Org-Id', orgId),
    )
      .send({ decision: 'rejected' })
      .expect(201);
  });

  it('unreachable reads as missing; reachable-but-not-permitted names what you cannot do', async () => {
    // Solo's workflow is in nobody else's org, so the member cannot even see that it exists.
    const hidden = await asSolo(
      http()
        .post('/api/deploy')
        .send({ workflow_json: ir('solo private') }),
    ).expect(201);
    const hiddenId = hidden.body.workflow_id as string;
    const unreachable = await asMember(http().get(`/api/workflows/${hiddenId}`)).expect(404);
    expect(unreachable.body.detail).toContain('not found');
    // Byte-identical to a workflow that never existed — the id must not confirm itself.
    const ghost = await asMember(http().get(`/api/workflows/${randomUUID()}`)).expect(404);
    expect(ghost.body.detail).toContain('not found');

    // In the shared org the member CAN read, so a refusal must say what they may not do instead.
    const shared = await asOwner(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({ workflow_json: ir('acme shared') }),
    ).expect(201);
    const sharedId = shared.body.workflow_id as string;
    await asMember(http().get(`/api/workflows/${sharedId}`).set('X-Org-Id', orgId)).expect(200);
    const refused = await asMember(http().delete(`/api/workflows/${sharedId}`).set('X-Org-Id', orgId)).expect(
      403,
    );
    expect(refused.body.detail).toContain('manage');
  });

  it('a workspace with nobody else to ask does not deadlock: the author may approve', async () => {
    const { workflowId, reviewId } = await openReview(asSolo, null, 'solo change');
    await asSolo(http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/approve`))
      .send({ decision: 'approved' })
      .expect(201);
    const merged = await asSolo(http().post(`/api/workflows/${workflowId}/reviews/${reviewId}/merge`))
      .send({})
      .expect(201);
    expect(merged.body.status).toBe('merged');
  });
});
