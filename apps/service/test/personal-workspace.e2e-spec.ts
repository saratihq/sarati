import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';

import { mintSession } from '../src/auth/local/local-session';
import { webhookDoc } from './support/golden-docs';
import { insertPersonalOrgs } from './support/personal-org';
import { SSO_SECRET_KEY, bootSsoApp, from, snapshotEnv } from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const NO_OTHER_MEMBERS = 'The personal organization has no other members';

/** A personal workspace has exactly one member, its owner (constitution row 22): no door adds, changes or removes one, and a member slipped past the database still lands in their own. */
describe('a personal workspace has exactly one member, its owner (e2e, isolated DB, sessions + API keys)', () => {
  let app: INestApplication;
  let db: Client;
  let restoreEnv: () => void;
  const owner = randomUUID();
  const personal = randomUUID();
  let ownerSession = '';
  let ownerKey = '';
  let team = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const as = (bearer: string, r: request.Test): request.Test => r.set('Authorization', `Bearer ${bearer}`);
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS rows`, params)).rows[0]!.n;
  const account = async (id: string, email: string): Promise<void> => {
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, $2, now(), now())`,
      [id, email],
    );
  };
  /** A membership the database refuses, written as an earlier version could have, past its foreign keys. */
  const slipIn = async (orgId: string, userId: string, role: string): Promise<void> => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query(
        `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [orgId, userId, role],
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  };
  const membersOf = async (orgId: string): Promise<Array<{ user_id: string; role: string }>> =>
    (
      await db.query(`SELECT user_id, role FROM org_members WHERE org_id = $1 ORDER BY role, user_id`, [
        orgId,
      ])
    ).rows as Array<{ user_id: string; role: string }>;

  beforeAll(async () => {
    restoreEnv = snapshotEnv();
    const databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await account(owner, 'owner@example.com');
    await insertPersonalOrgs(db, { id: personal, userId: owner, name: 'Owner' });
    app = await bootSsoApp(databaseUrl, {});
    ownerSession = (await mintSession(owner, SSO_SECRET_KEY)).token;
    team = (await as(ownerSession, from(app).post('/api/orgs')).send({ name: 'Team' }).expect(201)).body
      .id as string;
    ownerKey = (
      await as(ownerSession, from(app).post('/api/api-keys'))
        .send({ name: 'admin', scopes: ['org:manage', 'workflow:read'] })
        .expect(201)
    ).body.key as string;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    restoreEnv();
  });

  it('refuses an invite into it for every role, from its owner’s session and from their org:manage key, writing nothing', async () => {
    for (const bearer of [ownerSession, ownerKey]) {
      for (const role of ['member', 'admin', 'owner']) {
        const refused = await as(bearer, from(app).post(`/api/orgs/${personal}/invites`))
          .send({ email: `${role}@example.com`, role })
          .expect(400);
        expect(refused.body.detail).toBe(NO_OTHER_MEMBERS);
      }
    }
    expect(await count(`SELECT 1 FROM org_invites WHERE org_id = $1`, [personal])).toBe(0);
    expect(
      await count(`SELECT 1 FROM domain_events WHERE org_id = $1 AND type = 'org.member_invited'`, [
        personal,
      ]),
    ).toBe(0);

    await as(ownerSession, from(app).post(`/api/orgs/${team}/invites`).set('X-Org-Id', team))
      .send({ email: 'joiner@example.com', role: 'member' })
      .expect(201);
  });

  it('refuses a role change, a removal, a leave and an ownership transfer in it, from a session and an org:manage key, changing nothing', async () => {
    const stray = randomUUID();
    await account(stray, 'stray@example.com');
    await slipIn(personal, stray, 'member');
    try {
      const straySession = (await mintSession(stray, SSO_SECRET_KEY)).token;
      const doors = (bearer: string): request.Test[] => [
        as(bearer, http().patch(`/api/orgs/${personal}/members/${owner}`)).send({ role: 'admin' }),
        as(bearer, http().patch(`/api/orgs/${personal}/members/${stray}`)).send({ role: 'owner' }),
        as(bearer, http().delete(`/api/orgs/${personal}/members/${stray}`)),
        as(bearer, http().delete(`/api/orgs/${personal}/members/${owner}`)),
        as(bearer, http().post(`/api/orgs/${personal}/transfer-ownership`)).send({ user_id: stray }),
      ];
      for (const refused of [
        ...doors(ownerSession),
        ...doors(ownerKey),
        as(straySession, http().delete(`/api/orgs/${personal}/members/${stray}`)),
      ]) {
        const res = await refused;
        expect({ status: res.status, detail: res.body.detail }).toEqual({
          status: 400,
          detail: NO_OTHER_MEMBERS,
        });
      }
      expect(await membersOf(personal)).toEqual([
        { user_id: stray, role: 'member' },
        { user_id: owner, role: 'owner' },
      ]);
    } finally {
      await db.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [personal, stray]);
    }
  });

  it('lands a member slipped into it past the database in their own workspace without a header, marks only that one personal, pins their keys there, and asks them the role they hold in it', async () => {
    const stray = randomUUID();
    const own = randomUUID();
    await account(stray, 'slipped@example.com');
    await slipIn(personal, stray, 'member');
    await insertPersonalOrgs(db, { id: own, userId: stray, name: 'Slipped' });
    try {
      const session = (await mintSession(stray, SSO_SECRET_KEY)).token;
      const orgOf = async (workflowId: string): Promise<string> =>
        (await db.query(`SELECT org_id FROM workflows WHERE id = $1`, [workflowId])).rows[0]!
          .org_id as string;

      for (let i = 0; i < 5; i++) {
        const listed = await as(session, http().get('/api/orgs')).expect(200);
        expect(listed.body.orgs).toEqual([
          { id: own, name: 'Slipped', is_personal: true, role: 'owner' },
          { id: personal, name: 'Owner', is_personal: false, role: 'member' },
        ]);
      }
      const made = await as(session, http().post('/api/deploy'))
        .send({ workflow_json: webhookDoc('mine') })
        .expect(201);
      expect(await orgOf(made.body.workflow_id as string)).toBe(own);
      expect(made.body.is_live).toBe(true);
      const key = await as(session, http().post('/api/api-keys'))
        .send({ name: 'ci', scopes: ['workflow:read'] })
        .expect(201);
      expect((await db.query(`SELECT org_id FROM api_keys WHERE id = $1`, [key.body.id])).rows).toEqual([
        { org_id: own },
      ]);

      const there = await as(session, http().post('/api/deploy').set('X-Org-Id', personal))
        .send({ workflow_json: webhookDoc('theirs') })
        .expect(201);
      expect(await orgOf(there.body.workflow_id as string)).toBe(personal);
      expect(there.body.is_live).toBe(false);
    } finally {
      await db.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [personal, stray]);
    }
  });
});
