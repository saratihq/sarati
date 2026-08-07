import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A workflow whose step references a connection — with no env cluster it hard-fails at fire. */
function connIr(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'env conn flow',
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
        id: 'send',
        name: 'Send',
        node_type: 'slack.send_message',
        type_version: 1,
        parameters: { connectionId: randomUUID(), text: 'hi' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-send',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'send',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** A connection-less echo workflow fed by a canvas webhook trigger node (ADR 0018). */
function concatIr(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'env echo flow',
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
        parameters: { texts: ['got: ', '{{trigger.title}}'], separator: '' },
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

/** An approval-shaped built-in IR: parks on `orchestr:wait_for_event`, then echoes the decision. */
function approvalIr(topic: string): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'org approval flow',
    description: '',
    nodes: [
      {
        id: 'approval',
        name: 'Approval',
        node_type: 'orchestr:wait_for_event',
        type_version: 1,
        parameters: { topic, timeout_ms: 15_000 },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** Two real users via API-key auth — MOCK_AUTH can't mint a second identity. */
describe('organizations (e2e, isolated DB, two users via API keys)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID();
  const userB = randomUUID();
  const personalA = randomUUID();
  const personalB = randomUUID();
  const keyA = 'ork_e2e_owner_aaaaaaaaaaaaaaaaaaaaaaaa';
  const keyB = 'ork_e2e_member_bbbbbbbbbbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = ''; // "Acme" — created by A
  let betaId = ''; // second org of A, for cross-org invisibility
  let inviteToken = '';

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
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('GET /api/orgs — the personal org, role owner', async () => {
    const res = await asA(http().get('/api/orgs')).expect(200);
    expect(res.body.orgs).toEqual([{ id: personalA, name: 'Owner A', is_personal: true, role: 'owner' }]);
  });

  it('POST /api/orgs — creator becomes owner; list puts personal first', async () => {
    const res = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    expect(res.body.name).toBe('Acme');
    expect(res.body.is_personal).toBe(false);
    expect(res.body.role).toBe('owner');
    orgId = res.body.id as string;

    const list = await asA(http().get('/api/orgs')).expect(200);
    expect(list.body.orgs.map((o: { id: string }) => o.id)).toEqual([personalA, orgId]);

    const empty = await asA(http().post('/api/orgs').send({ name: '' })).expect(400);
    expect(empty.body.detail).toBeDefined();
  });

  it('PATCH /api/orgs/:id — rename; personal org refuses; non-member 403; unknown 404', async () => {
    const res = await asA(http().patch(`/api/orgs/${orgId}`).send({ name: 'Acme Corp' })).expect(200);
    expect(res.body.name).toBe('Acme Corp');

    const personal = await asA(http().patch(`/api/orgs/${personalA}`).send({ name: 'X' })).expect(400);
    expect(personal.body.detail).toBe('The personal organization cannot be renamed');

    const foreign = await asB(http().patch(`/api/orgs/${orgId}`).send({ name: 'Hijack' })).expect(403);
    expect(foreign.body.detail).toBe('Not a member of this organization');

    await asA(http().patch(`/api/orgs/${randomUUID()}`).send({ name: 'X' })).expect(404);
  });

  it('invite: owner invites; token returned; duplicate pending 409; bad email 400', async () => {
    const res = await asA(
      http().post(`/api/orgs/${orgId}/invites`).send({ email: 'member-b@e2e.local', role: 'member' }),
    ).expect(201);
    expect(res.body.email).toBe('member-b@e2e.local');
    expect(res.body.role).toBe('member');
    expect(String(res.body.token)).toMatch(/^[0-9a-f]{40,}$/);
    inviteToken = res.body.token as string;

    const dup = await asA(
      http().post(`/api/orgs/${orgId}/invites`).send({ email: 'Member-B@e2e.local', role: 'admin' }),
    ).expect(409);
    expect(dup.body.detail).toBe('An invite for this email is already pending');

    await asA(http().post(`/api/orgs/${orgId}/invites`).send({ email: 'not-an-email' })).expect(400);

    const pending = await asA(http().get(`/api/orgs/${orgId}/invites`)).expect(200);
    expect(pending.body.invites).toHaveLength(1);
    expect(pending.body.invites[0].email).toBe('member-b@e2e.local');
    // The token IS the delivery mechanism in OSS (no mailer) — owners/admins must be able to re-copy it.
    expect(pending.body.invites[0].token).toBe(inviteToken);
    const msUntilExpiry = new Date(pending.body.invites[0].expires_at).getTime() - Date.now();
    expect(msUntilExpiry).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
  });

  it('accept: second user joins by token; idempotent re-accept; unknown token 404', async () => {
    await asB(http().post(`/api/orgs/invites/${'0'.repeat(48)}/accept`)).expect(404);

    // Preview (idempotent GET) shows org + role WITHOUT consuming the token.
    const peek = await asB(http().get(`/api/orgs/invites/${inviteToken}`)).expect(200);
    expect(peek.body).toMatchObject({ org_id: orgId, org_name: 'Acme Corp', role: 'member' });
    await asB(http().get(`/api/orgs/invites/${'0'.repeat(48)}`)).expect(404);

    const res = await asB(http().post(`/api/orgs/invites/${inviteToken}/accept`)).expect(200);
    expect(res.body).toEqual({ org_id: orgId, name: 'Acme Corp' });

    // Already-a-member → 200 idempotent (even though the invite is consumed).
    const again = await asB(http().post(`/api/orgs/invites/${inviteToken}/accept`)).expect(200);
    expect(again.body.org_id).toBe(orgId);

    // Consumed: recorded accepted_by/accepted_at; no longer pending.
    const row = await db.query(`SELECT accepted_by, accepted_at FROM org_invites WHERE token = $1`, [
      inviteToken,
    ]);
    expect(row.rows[0].accepted_by).toBe(userB);
    expect(row.rows[0].accepted_at).not.toBeNull();
    const pending = await asA(http().get(`/api/orgs/${orgId}/invites`)).expect(200);
    expect(pending.body.invites).toHaveLength(0);

    const list = await asB(http().get('/api/orgs')).expect(200);
    expect(list.body.orgs.map((o: { id: string; role: string }) => [o.id, o.role])).toEqual([
      [personalB, 'owner'],
      [orgId, 'member'],
    ]);
  });

  it('members: every member sees the roster with email/name/joined_at', async () => {
    const res = await asB(http().get(`/api/orgs/${orgId}/members`)).expect(200);
    expect(res.body.members).toHaveLength(2);
    const [a, b] = res.body.members;
    expect(a).toMatchObject({ user_id: userA, email: 'owner-a@e2e.local', name: 'Owner A', role: 'owner' });
    expect(b).toMatchObject({ user_id: userB, role: 'member' });
    expect(typeof b.joined_at).toBe('string');
  });

  it('role policy: a member can neither invite, rename, list invites, change roles, nor remove others', async () => {
    const invite = await asB(http().post(`/api/orgs/${orgId}/invites`).send({ email: 'x@e2e.local' })).expect(
      403,
    );
    expect(invite.body.detail).toBe('Only owners and admins can manage this organization');

    await asB(http().patch(`/api/orgs/${orgId}`).send({ name: 'Nope' })).expect(403);
    await asB(http().get(`/api/orgs/${orgId}/invites`)).expect(403);

    const role = await asB(
      http().patch(`/api/orgs/${orgId}/members/${userA}`).send({ role: 'member' }),
    ).expect(403);
    expect(role.body.detail).toBe('Only owners can change member roles');

    await asB(http().delete(`/api/orgs/${orgId}/members/${userA}`)).expect(403);
  });

  it('last-owner protection: the only owner can neither demote itself nor leave', async () => {
    const demote = await asA(
      http().patch(`/api/orgs/${orgId}/members/${userA}`).send({ role: 'member' }),
    ).expect(400);
    expect(demote.body.detail).toBe('Cannot demote the last owner');

    const leave = await asA(http().delete(`/api/orgs/${orgId}/members/${userA}`)).expect(400);
    expect(leave.body.detail).toBe('The last owner cannot leave the organization');

    // With a second owner the demotion goes through — then restore.
    await asA(http().patch(`/api/orgs/${orgId}/members/${userB}`).send({ role: 'owner' })).expect(200);
    await asA(http().patch(`/api/orgs/${orgId}/members/${userA}`).send({ role: 'admin' })).expect(200);
    await asA(http().patch(`/api/orgs/${orgId}/members/${userA}`).send({ role: 'owner' })).expect(403); // admin ≠ owner
    await asB(http().patch(`/api/orgs/${orgId}/members/${userA}`).send({ role: 'owner' })).expect(200);
    await asA(http().patch(`/api/orgs/${orgId}/members/${userB}`).send({ role: 'member' })).expect(200);

    const unknown = await asA(
      http().patch(`/api/orgs/${orgId}/members/${randomUUID()}`).send({ role: 'member' }),
    ).expect(404);
    expect(unknown.body.detail).toBe('Member not found');

    await asA(http().patch(`/api/orgs/${orgId}/members/${userB}`).send({ role: 'viewer' })).expect(400); // not an assignable role
  });

  it('transfer ownership: only an owner may; atomic hand-off drops caller to admin; self/unknown rejected; restores', async () => {
    const byMember = await asB(
      http().post(`/api/orgs/${orgId}/transfer-ownership`).send({ user_id: userA }),
    ).expect(403);
    expect(byMember.body.detail).toBe('Only an owner can transfer ownership');

    const toSelf = await asA(
      http().post(`/api/orgs/${orgId}/transfer-ownership`).send({ user_id: userA }),
    ).expect(400);
    expect(toSelf.body.detail).toBe('You are already the owner');
    await asA(http().post(`/api/orgs/${orgId}/transfer-ownership`).send({ user_id: randomUUID() })).expect(
      404,
    );

    // Owner hands off to B: caller drops to admin, B becomes owner — atomically.
    const done = await asA(
      http().post(`/api/orgs/${orgId}/transfer-ownership`).send({ user_id: userB }),
    ).expect(201);
    expect(done.body).toMatchObject({ id: orgId, role: 'admin' });

    const roster = await asA(http().get(`/api/orgs/${orgId}/members`)).expect(200);
    const roleById = Object.fromEntries(
      roster.body.members.map((m: { user_id: string; role: string }) => [m.user_id, m.role]),
    );
    expect(roleById[userA]).toBe('admin');
    expect(roleById[userB]).toBe('owner');

    // The ex-owner (now admin) can no longer transfer.
    await asA(http().post(`/api/orgs/${orgId}/transfer-ownership`).send({ user_id: userB })).expect(403);

    // Restore: B hands ownership back to A, then A demotes B to member.
    await asB(http().post(`/api/orgs/${orgId}/transfer-ownership`).send({ user_id: userA })).expect(201);
    await asA(http().patch(`/api/orgs/${orgId}/members/${userB}`).send({ role: 'member' })).expect(200);
    const restored = await asA(http().get(`/api/orgs/${orgId}/members`)).expect(200);
    const roles = Object.fromEntries(
      restored.body.members.map((m: { user_id: string; role: string }) => [m.user_id, m.role]),
    );
    expect(roles[userA]).toBe('owner');
    expect(roles[userB]).toBe('member');
  });

  it('X-Org-Id scoping: workflows land in and list from the ACTIVE org', async () => {
    const beta = await asA(http().post('/api/orgs').send({ name: 'Beta' })).expect(201);
    betaId = beta.body.id as string;

    // Create on the built-in engine (no external push) with org "Acme" active.
    const dep = await asA(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({
          workflow_json: {
            name: 'Acme Flow',
            nodes: [{ id: 'n1', node_type: 'text.concat', name: 'Step', parameters: {} }],
            edges: [],
          },
        }),
    ).expect(201);
    const wfId = dep.body.workflow_id as string;
    const orgRow = await db.query(`SELECT org_id FROM workflows WHERE id = $1`, [wfId]);
    expect(orgRow.rows[0].org_id).toBe(orgId);

    // Visible in the org it was created in — for BOTH members.
    const inAcme = await asA(http().get('/api/workflows').set('X-Org-Id', orgId)).expect(200);
    expect(inAcme.body.workflows.map((w: { id: string }) => w.id)).toEqual([wfId]);
    const forB = await asB(http().get('/api/workflows').set('X-Org-Id', orgId)).expect(200);
    expect(forB.body.total).toBe(1);

    // Invisible from org Beta and from the personal-org default (no header).
    const inBeta = await asA(http().get('/api/workflows').set('X-Org-Id', betaId)).expect(200);
    expect(inBeta.body.total).toBe(0);
    const personal = await asA(http().get('/api/workflows')).expect(200);
    expect(personal.body.total).toBe(0);

    // Non-members can't activate the org at all.
    const foreign = await asB(http().get('/api/workflows').set('X-Org-Id', betaId)).expect(403);
    expect(foreign.body.detail).toBe('Not a member of this organization');
    await asA(http().get('/api/workflows').set('X-Org-Id', 'not-a-uuid')).expect(403);

    // Org members reach the workflow itself (policy by the workflow's org).
    await asB(http().get(`/api/workflows/${wfId}`)).expect(200);
  });

  /** Org-wide approvals are a SESSION capability (proven in mcp-runs.e2e-spec); a key reaches only its own runs. */
  it('a KEY gets no org-wide reach: another member cannot see or resume a parked run through one', async () => {
    // The run is NOT awaited — it parks on the wait node. Its owner is A.
    const dep = await asA(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', orgId)
        .send({ workflow_json: approvalIr('approve') }),
    ).expect(201);
    const apprWf = dep.body.workflow_id as string;

    const pending = asA(
      http()
        .post('/api/runs/from-ir')
        .set('X-Org-Id', orgId)
        // A key may not choose its own run id — the server mints one, read back off the inbox.
        .send({ workflow_ir: approvalIr('approve'), workflow_id: apprWf }),
    ).then((r) => r);

    // The owner's own key sees it; the inbox hands back the UNIQUE handle (`<owner>:<run>`).
    let waiting: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !waiting; i++) {
      const res = await asA(http().get('/api/runs/waiting').set('X-Org-Id', orgId)).expect(200);
      waiting = (res.body.runs as Array<Record<string, unknown>>).find((r) => r.workflow_id === apprWf);
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting).toBeDefined();
    expect(waiting).toMatchObject({ workflow_id: apprWf, topic: 'approve' });
    expect((waiting!.triggered_by as { id: string }).id).toBe(userA);
    const runId = waiting!.run_id as string;
    const runRef = waiting!.id as string;
    expect(runRef).toContain(userA);
    const ref = encodeURIComponent(runRef);

    // B's KEY is in the same org and still sees nothing of A's run — with or without the org header,
    // and not even holding the exact handle (an agent loop must not harvest other members' runs).
    for (const inbox of [
      asB(http().get('/api/runs/waiting').set('X-Org-Id', orgId)),
      asB(http().get('/api/runs/waiting')),
    ]) {
      const res = await inbox.expect(200);
      expect((res.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).not.toContain(runId);
    }
    await asB(http().post(`/api/runs/${ref}/events`).send({ topic: 'approve', payload: {} })).expect(404);
    await asB(
      http().post(`/api/runs/${ref}/events`).set('X-Org-Id', orgId).send({ topic: 'approve', payload: {} }),
    ).expect(404);
    const denied = await asB(http().get(`/api/runs/${ref}`).set('X-Org-Id', orgId)).expect(200);
    expect(denied.body.status).toBe('not_found');

    // The owner resumes their own run.
    await asA(
      http()
        .post(`/api/runs/${ref}/events`)
        .set('X-Org-Id', orgId)
        .send({ topic: 'approve', payload: { decision: 'approved' } }),
    ).expect(200);

    const result = await pending;
    expect(result.status).toBe(201);
    expect(result.body.outputs.approval).toEqual({ decision: 'approved' });

    const detail = await asA(http().get(`/api/runs/${ref}`).set('X-Org-Id', orgId)).expect(200);
    expect(detail.body.decided_by?.id).toBe(userA);
    expect(detail.body.decided_at).toBeTruthy();

    // Resolved → off the inbox.
    const after = await asA(http().get('/api/runs/waiting').set('X-Org-Id', orgId)).expect(200);
    expect((after.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).not.toContain('org-appr-1');
  }, 20_000);

  it('connection clusters: owner/admin manage; member 403; list + delete; bad env 400', async () => {
    // A member can neither list nor connect clusters.
    await asB(http().get(`/api/orgs/${orgId}/clusters`)).expect(403);
    await asB(http().post(`/api/orgs/${orgId}/clusters/prod/connect`).send({ app: 'slack' })).expect(403);

    // Owner: empty to start.
    const empty = await asA(http().get(`/api/orgs/${orgId}/clusters`)).expect(200);
    expect(empty.body.clusters).toEqual([]);

    // Seed a managed cluster connection (org+env tagged, owned by A) and see it listed.
    const connId = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
       VALUES ($1,$2,'slack','managed','enc',now(),'active',$3,'prod')`,
      [connId, userA, orgId],
    );
    const list = await asA(http().get(`/api/orgs/${orgId}/clusters`)).expect(200);
    expect(list.body.clusters).toHaveLength(1);
    expect(list.body.clusters[0]).toMatchObject({ id: connId, provider: 'slack', environment: 'prod' });

    // The cluster row must not leak into personal connections, nor be removable by the personal delete.
    const personal = await asA(http().get('/api/connections')).expect(200);
    expect((personal.body as Array<{ id: string }>).some((c) => c.id === connId)).toBe(false);
    await asA(http().delete(`/api/connections/${connId}`)).expect(404);

    // An invalid environment name is rejected before any connect work.
    await asA(http().post(`/api/orgs/${orgId}/clusters/bad.env/connect`).send({ app: 'slack' })).expect(400);

    // Owner removes it; a second delete is a 404.
    const del = await asA(http().delete(`/api/orgs/${orgId}/clusters/connections/${connId}`)).expect(200);
    expect(del.body.status).toBe('deleted');
    const after = await asA(http().get(`/api/orgs/${orgId}/clusters`)).expect(200);
    expect(after.body.clusters).toEqual([]);
    await asA(http().delete(`/api/orgs/${orgId}/clusters/connections/${randomUUID()}`)).expect(404);
  });

  it('cluster owner lifecycle: an ACTIVE cluster connection blocks its owner; failed rows do not', async () => {
    // A FAILED cluster connection runs nothing → must NOT block removal.
    const dead = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
       VALUES ($1,$2,'gmail','managed','enc',now(),'failed',$3,'prod')`,
      [dead, userB, orgId],
    );
    // (Can't actually remove B — later tests need them — but an ACTIVE row must block.)
    const active = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
       VALUES ($1,$2,'slack','managed','enc',now(),'active',$3,'prod')`,
      [active, userB, orgId],
    );
    const blocked = await asA(http().delete(`/api/orgs/${orgId}/members/${userB}`)).expect(409);
    expect(blocked.body.detail).toMatch(/connection/i);

    await db.query(`DELETE FROM connections WHERE id = ANY($1)`, [[dead, active]]);
  });

  it('member-leave SLOT guard (ADR 0014, P0): a member whose PERSONAL connection fills an org env slot is 409-blocked until the slot is freed', async () => {
    // Env SLOTS reference PERSONAL pool connections (`org_id` NULL), not cluster rows.
    const slotOrg = await asA(http().post('/api/orgs').send({ name: 'Slot Guard Co' })).expect(201);
    const slotOrgId = slotOrg.body.id as string;
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
      [slotOrgId, userB],
    );

    // Lazy defaults give the org a staging environment (owner-curated).
    const envs = await asA(http().get('/api/environments').set('X-Org-Id', slotOrgId)).expect(200);
    const staging = (envs.body.environments as Array<{ id: string; name: string }>).find(
      (e) => e.name === 'staging',
    )!;

    // The slot-assign API only slots the caller's OWN connections, so this state is built directly.
    const bConn = await asB(
      http().post('/api/connections').send({ provider: 'gmail', credential: 'b-personal' }),
    ).expect(201);
    const bConnId = bConn.body.id as string;
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id, created_at)
       VALUES ($1, 'gmail', $2, now())`,
      [staging.id, bConnId],
    );

    // LEAVE is now blocked — the personal connection strands the org's staging env.
    const blockedLeave = await asB(http().delete(`/api/orgs/${slotOrgId}/members/${userB}`)).expect(409);
    expect(blockedLeave.body.detail).toMatch(/environments rely on/i);
    expect(blockedLeave.body.detail).toMatch(/reassign the slot/i);
    // The guard aborted the delete — B is still a member.
    const roster = await asA(http().get(`/api/orgs/${slotOrgId}/members`)).expect(200);
    expect(roster.body.members.map((m: { user_id: string }) => m.user_id)).toContain(userB);

    // DEMOTE is guarded the same way (block-parity).
    await asA(http().patch(`/api/orgs/${slotOrgId}/members/${userB}`).send({ role: 'admin' })).expect(200);
    const blockedDemote = await asA(
      http().patch(`/api/orgs/${slotOrgId}/members/${userB}`).send({ role: 'member' }),
    ).expect(409);
    expect(blockedDemote.body.detail).toMatch(/reassign the slot/i);

    // Free the slot (owner reassigns/empties it) → the guard clears for BOTH sites.
    await db.query(`DELETE FROM environment_connections WHERE environment_id = $1 AND app = 'gmail'`, [
      staging.id,
    ]);

    // An un-slotted personal connection must never false-block a demote or leave.
    await asA(http().patch(`/api/orgs/${slotOrgId}/members/${userB}`).send({ role: 'member' })).expect(200);
    const left = await asB(http().delete(`/api/orgs/${slotOrgId}/members/${userB}`)).expect(200);
    expect(left.body.status).toBe('left');
    await asB(http().get(`/api/orgs/${slotOrgId}/members`)).expect(403); // no longer a member
  });

  it('canvas env-scoped triggers (ADR 0018): a staging webhook fire carries the environment through to the resolver', async () => {
    // The per-`(workflow, env)` URL fires the staging-pinned version.
    const dep = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: concatIr() }),
    ).expect(201);
    const wfId = dep.body.workflow_id as string;

    const promoteStagingTo = async (workflowId: string): Promise<void> => {
      const versions = await asA(
        http().get(`/api/workflows/${workflowId}/versions`).set('X-Org-Id', orgId),
      ).expect(200);
      const v1 = (versions.body.versions as Array<{ id: string; version_number: number }>).find(
        (v) => v.version_number === 1,
      )!;
      await asA(
        http()
          .post(`/api/workflows/${workflowId}/promote`)
          .set('X-Org-Id', orgId)
          .send({ environment: 'staging', version_id: v1.id }),
      ).expect(201);
    };
    await promoteStagingTo(wfId);

    // An unauthenticated fire must produce a run that CARRIES environment=staging.
    const fired = await http().post(`/api/hooks/${wfId}/staging`).send({ title: 'hello' }).expect(202);
    const runId = fired.body.run_id as string;

    let row: { status: string; environment: string | null } | undefined;
    for (let i = 0; i < 100 && (!row || row.status === 'running'); i++) {
      const q = await db.query(`SELECT status, environment FROM runtime_runs WHERE run_id = $1`, [runId]);
      row = q.rows[0] as { status: string; environment: string | null } | undefined;
      if (!row || row.status === 'running') await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.environment).toBe('staging');
    expect(row?.status).toBe('completed');

    // The hard-fail below can only happen if BOTH environment AND org threaded through to the resolver.
    const connDep = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: connIr() }),
    ).expect(201);
    const connWfId = connDep.body.workflow_id as string;
    await promoteStagingTo(connWfId);
    const connFired = await http().post(`/api/hooks/${connWfId}/staging`).send({ title: 'x' }).expect(202);

    let errRow: { status: string; error: string | null } | undefined;
    for (let i = 0; i < 100 && (!errRow || errRow.status === 'running'); i++) {
      const q = await db.query(`SELECT status, error FROM runtime_runs WHERE run_id = $1`, [
        connFired.body.run_id,
      ]);
      errRow = q.rows[0] as { status: string; error: string | null } | undefined;
      if (!errRow || errRow.status === 'running') await new Promise((r) => setTimeout(r, 50));
    }
    expect(errRow?.status).toBe('error');
    expect(errRow?.error).toMatch(/staging environment/i);
  }, 30_000);

  it('delete org: owner-only; personal + non-empty refused; an empty org is removed', async () => {
    // The owner-gate must fire before anything destructive.
    const byMember = await asB(http().delete(`/api/orgs/${orgId}`)).expect(403);
    expect(byMember.body.detail).toBe('Only an owner can delete the organization');

    // The personal org can never be deleted.
    await asA(http().delete(`/api/orgs/${personalA}`)).expect(400);

    // A throwaway org with a workflow → refuses (deleting would orphan it).
    const disp = await asA(http().post('/api/orgs').send({ name: 'Disposable' })).expect(201);
    const dispId = disp.body.id as string;
    await asA(
      http()
        .post('/api/deploy')
        .set('X-Org-Id', dispId)
        .send({
          workflow_json: {
            name: 'blocker',
            nodes: [
              { id: 'n1', node_type: 'text.concat', name: 'S', parameters: { texts: ['a'], separator: '' } },
            ],
            edges: [],
          },
        }),
    ).expect(201);
    const nonEmpty = await asA(http().delete(`/api/orgs/${dispId}`)).expect(409);
    expect(nonEmpty.body.detail).toMatch(/workflow/i);

    // An empty org deletes cleanly and vanishes from the owner's list.
    const empty = await asA(http().post('/api/orgs').send({ name: 'Empty' })).expect(201);
    const emptyId = empty.body.id as string;
    // `connections` has no FK to orgs, so the delete must tear cluster rows down explicitly.
    const clusterInEmpty = randomUUID();
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
       VALUES ($1,$2,'slack','managed','enc',now(),'active',$3,'prod')`,
      [clusterInEmpty, userA, emptyId],
    );
    const gone = await asA(http().delete(`/api/orgs/${emptyId}`)).expect(200);
    expect(gone.body.status).toBe('deleted');
    const orphan = await db.query(`SELECT 1 FROM connections WHERE id = $1`, [clusterInEmpty]);
    expect(orphan.rows).toHaveLength(0); // cleaned up, not orphaned
    const list = await asA(http().get('/api/orgs')).expect(200);
    expect(list.body.orgs.map((o: { id: string }) => o.id)).not.toContain(emptyId);
    await asA(http().get(`/api/orgs/${emptyId}/members`)).expect(404); // fully gone
  });

  it('leave: a non-last-owner member removes itself; owner removes others', async () => {
    const left = await asB(http().delete(`/api/orgs/${orgId}/members/${userB}`)).expect(200);
    expect(left.body.status).toBe('left');
    await asB(http().get(`/api/orgs/${orgId}/members`)).expect(403); // no longer a member

    // Re-admit B (fresh invite), then the owner removes them.
    const invite = await asA(
      http().post(`/api/orgs/${orgId}/invites`).send({ email: 'member-b@e2e.local' }),
    ).expect(201);
    await asB(http().post(`/api/orgs/invites/${invite.body.token}/accept`)).expect(200);
    const removed = await asA(http().delete(`/api/orgs/${orgId}/members/${userB}`)).expect(200);
    expect(removed.body.status).toBe('removed');
    const members = await asA(http().get(`/api/orgs/${orgId}/members`)).expect(200);
    expect(members.body.members.map((m: { user_id: string }) => m.user_id)).toEqual([userA]);
  });

  it('revoke + expiry: revoked and expired invites 404 on accept (for a NON-member) and leave the pending list', async () => {
    const revokable = await asA(
      http().post(`/api/orgs/${orgId}/invites`).send({ email: 'c@e2e.local', role: 'admin' }),
    ).expect(201);
    await asA(http().delete(`/api/orgs/${orgId}/invites/${revokable.body.id}`)).expect(200);
    await asA(http().delete(`/api/orgs/${orgId}/invites/${revokable.body.id}`)).expect(404);
    await asB(http().post(`/api/orgs/invites/${revokable.body.token}/accept`)).expect(404);

    const expiring = await asA(
      http().post(`/api/orgs/${orgId}/invites`).send({ email: 'd@e2e.local' }),
    ).expect(201);
    await db.query(`UPDATE org_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      expiring.body.id,
    ]);
    const expired = await asB(http().post(`/api/orgs/invites/${expiring.body.token}/accept`)).expect(404);
    expect(expired.body.detail).toBe('Invite not found or expired');
    const pending = await asA(http().get(`/api/orgs/${orgId}/invites`)).expect(200);
    expect(pending.body.invites).toHaveLength(0);
  });

  it('domain events carry the org lifecycle', async () => {
    const rows = await db.query(`SELECT DISTINCT type FROM domain_events WHERE org_id = $1 ORDER BY type`, [
      orgId,
    ]);
    const types = rows.rows.map((r: { type: string }) => r.type);
    for (const expected of [
      'org.created',
      'org.renamed',
      'org.member_invited',
      'org.member_joined',
      'org.member_role_changed',
      'org.ownership_transferred',
      'org.member_left',
      'org.member_removed',
      'org.invite_revoked',
      'workflow.created',
    ]) {
      expect(types).toContain(expected);
    }
  });
});
