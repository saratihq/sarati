import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import type request from 'supertest';

import { mintSession } from '../src/auth/local/local-session';
import { webhookDoc } from './support/golden-docs';
import { pause } from './support/lock-probes';
import { SSO_SECRET_KEY, bootSsoApp, from, snapshotEnv } from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M044 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '044_personal_org_single_member.sql'),
  'utf8',
);

const TABLES = ['organizations', 'org_members'];

/** Takes a database built from `schema.sql` back to the shape 044 finds on an earlier version's. */
async function undo044(db: Client): Promise<void> {
  for (const statement of [
    `DROP TRIGGER organizations_personal_owner_check ON organizations`,
    `DROP TRIGGER org_members_claim_personal_org ON org_members`,
    `DROP FUNCTION check_personal_owner(), claim_personal_org()`,
    `ALTER TABLE organizations DROP CONSTRAINT organizations_personal_owner_member_fkey`,
    `ALTER TABLE org_members DROP CONSTRAINT org_members_org_id_is_personal_fkey`,
    `DROP INDEX uq_org_members_personal_org`,
    `ALTER TABLE org_members DROP COLUMN is_personal`,
    `ALTER TABLE organizations DROP CONSTRAINT organizations_id_is_personal_key`,
    `ALTER TABLE organizations DROP COLUMN personal_owner_id`,
  ]) {
    await db.query(statement);
  }
}

/** Columns, constraints, indexes and triggers of the two tables 044 changes, so a migrated database can be compared with a fresh one. */
async function shapeOf(db: Client): Promise<unknown> {
  const columns = await db.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, column_name`,
    [TABLES],
  );
  const constraints = await db.query(
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid::regclass::text = ANY($1) ORDER BY conname`,
    [TABLES],
  );
  const indexes = await db.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1) ORDER BY indexname`,
    [TABLES],
  );
  const triggers = await db.query(
    `SELECT t.tgrelid::regclass::text AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS definition,
            pg_get_functiondef(t.tgfoid) AS function
       FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid::regclass::text = ANY($1) ORDER BY t.tgname`,
    [TABLES],
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
  };
}

/** Every row 044 may touch, so a second run can be shown to change none of them. */
async function rowsOf(db: Client): Promise<unknown> {
  const all = async (sql: string): Promise<unknown[]> => (await db.query(sql)).rows;
  return {
    organizations: await all(
      `SELECT id, name, is_personal, personal_owner_id, environments_seeded_at FROM organizations ORDER BY id`,
    ),
    members: await all(`SELECT id, org_id, user_id, role, is_personal FROM org_members ORDER BY id`),
    invites: await all(`SELECT id, org_id, accepted_by FROM org_invites ORDER BY id`),
    keys: await all(`SELECT id, org_id, revoked_at FROM api_keys ORDER BY id`),
    slots: await all(`SELECT environment_id, app, connection_id FROM environment_connections ORDER BY 1, 2`),
    environments: await all(`SELECT id, org_id, name FROM environments ORDER BY id`),
    workflows: await all(`SELECT id, org_id, user_id FROM workflows ORDER BY id`),
  };
}

const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

/** 044 on data an earlier version let an invite into a personal workspace leave behind; `db:migrate` re-runs it on every boot. Scratch DBs. */
describe('migration 044: a personal workspace keeps exactly one member, its owner (scratch DBs)', () => {
  let migrated: Client;
  let fresh: Client;
  let databaseUrl = '';
  const warnings: string[] = [];

  const a = randomUUID();
  const b = randomUUID();
  const c = randomUUID();
  const d = randomUUID();
  const e = randomUUID();
  const f = randomUUID();
  const g = randomUUID();
  const h = randomUUID();
  const k = randomUUID();
  const l = randomUUID();
  const pa = randomUUID();
  const pb = randomUUID();
  const pc = randomUUID();
  const pd = randomUUID();
  const pe = randomUUID();
  const pg = randomUUID();
  const ph = randomUUID();
  const pk = randomUUID();
  const pl = randomUUID();
  const pd2 = randomUUID();
  const px = randomUUID();
  const shared = randomUUID();
  const ids = {
    paStaging: randomUUID(),
    paProduction: randomUUID(),
    bConnection: randomUUID(),
    cConnection: randomUUID(),
    aConnection: randomUUID(),
    bWorkflowInPa: randomUUID(),
    bWorkflowInPb: randomUUID(),
    pendingInvite: randomUUID(),
    expiredInvite: randomUUID(),
    sharedInvite: randomUUID(),
  };
  const keys = {
    bPinnedToPa: 'ork_e2e_044_b_pinned_to_pa_aaaaaaaaaa',
    aPinnedToPa: 'ork_e2e_044_a_pinned_to_pa_bbbbbbbbbb',
    bUnpinned: 'ork_e2e_044_b_unpinned_cccccccccccccc',
    dPinnedToPd2: 'ork_e2e_044_d_pinned_to_pd2_dddddddd',
    gPinnedToPd2: 'ork_e2e_044_g_pinned_to_pd2_eeeeeeee',
  };

  const sql = (text: string, params: unknown[] = []) => migrated.query(text, params);
  const user = (id: string, email: string, name: string) =>
    sql(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`, [
      id,
      email,
      name,
    ]);
  const org = (id: string, name: string, personal: boolean, daysAgo: number) =>
    sql(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, $3, now() - make_interval(days => $4), now())`,
      [id, name, personal, daysAgo],
    );
  const member = (orgId: string, userId: string, role: string, daysAgo: number) =>
    sql(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - make_interval(days => $4))`,
      [orgId, userId, role, daysAgo],
    );
  const accepted = (
    orgId: string,
    by: string,
    joiner: string,
    email: string,
    role: string,
    daysAgo: number,
  ) =>
    sql(
      `INSERT INTO org_invites (id, org_id, email, role, token, created_by, created_at, expires_at, accepted_by, accepted_at)
       VALUES (gen_random_uuid(), $1, $4, $5, $6, $2, now() - make_interval(days => $7 + 1),
               now() + interval '13 days', $3, now() - make_interval(days => $7))`,
      [orgId, by, joiner, email, role, `tok_${randomUUID()}`, daysAgo],
    );
  const event = (orgId: string, actor: string, type: string) =>
    sql(
      `INSERT INTO domain_events (id, org_id, actor_user_id, type, subject_type, subject_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'user', $4, now())`,
      [orgId, actor, type, actor],
    );
  const membersOf = async (orgId: string): Promise<Array<{ user_id: string; role: string }>> =>
    (await sql(`SELECT user_id, role FROM org_members WHERE org_id = $1 ORDER BY role, user_id`, [orgId]))
      .rows as Array<{ user_id: string; role: string }>;
  const firstRun: string[] = [];

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    migrated = new Client({ connectionString: databaseUrl });
    fresh = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await Promise.all([migrated.connect(), fresh.connect()]);
    await undo044(migrated);
    migrated.on('notice', (notice) => {
      if (notice.severity === 'WARNING') warnings.push(notice.message ?? '');
    });

    await user(a, 'a@example.com', 'Ada');
    await user(b, 'b@example.com', 'Bo');
    await user(c, 'c@example.com', 'Cy');
    await user(d, 'd@example.com', 'Di');
    await user(e, 'e@example.com', 'Ed');
    await user(f, 'f@example.com', 'Fay');
    await user(g, 'g@example.com', 'Gus');
    await user(h, 'h@example.com', 'Hal');
    await user(k, 'k@example.com', 'Kit');
    await user(l, 'l@example.com', 'Lou');

    for (const [own, owner, name] of [
      [pb, b, 'Bo'],
      [pc, c, 'Cy'],
      [pe, e, 'Ed'],
      [pg, g, 'Gus'],
      [pk, k, 'Kit'],
      [pl, l, 'Lou'],
    ] as const) {
      await org(own, name, true, 99);
      await member(own, owner, 'owner', 99);
    }

    // Ada's workspace, made when her account was: Bo joined it, Cy joined as owner and demoted Ada, Fay joined and was adopted there.
    await org(pa, 'Ada', true, 100);
    await member(pa, a, 'member', 100);
    await event(pa, a, 'user.provisioned');
    await member(pa, b, 'member', 95);
    await accepted(pa, a, b, 'b@example.com', 'member', 95);
    await member(pa, c, 'owner', 94);
    await accepted(pa, a, c, 'c@example.com', 'owner', 94);
    await member(pa, f, 'admin', 50);
    await accepted(pa, a, f, 'f@example.com', 'admin', 50);
    await event(pa, f, 'user.adopted');
    await sql(
      `INSERT INTO org_invites (id, org_id, email, role, token, created_by, created_at, expires_at)
       VALUES ($1, $3, 'x@example.com', 'member', $4, $5, now(), now() + interval '14 days'),
              ($2, $3, 'y@example.com', 'admin', $6, $5, now() - interval '20 days', now() - interval '6 days')`,
      [ids.pendingInvite, ids.expiredInvite, pa, `tok_${randomUUID()}`, a, `tok_${randomUUID()}`],
    );
    await sql(
      `INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $3, 'production', true), ($2, $3, 'staging', false)`,
      [ids.paProduction, ids.paStaging, pa],
    );
    await sql(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential)
       VALUES ($1, $4, 'gmail', 'token', 'x'), ($2, $5, 'slack', 'token', 'x'), ($3, $6, 'gmail', 'token', 'x')`,
      [ids.bConnection, ids.cConnection, ids.aConnection, b, c, a],
    );
    await sql(
      `INSERT INTO environment_connections (environment_id, app, connection_id)
       VALUES ($1, 'gmail', $3), ($2, 'slack', $4), ($2, 'gmail', $5)`,
      [ids.paStaging, ids.paProduction, ids.bConnection, ids.cConnection, ids.aConnection],
    );
    await sql(
      `INSERT INTO workflows (id, name, user_id, org_id) VALUES ($1, 'Bo in Ada', $3, $4), ($2, 'Bo at home', $3, $5)`,
      [ids.bWorkflowInPa, ids.bWorkflowInPb, b, pa, pb],
    );
    await sql(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'bo in ada', $3, $4, '["workflow:read"]', now()),
              (gen_random_uuid(), $5, $2, 'ada at home', $6, $7, '["workflow:read"]', now()),
              (gen_random_uuid(), $1, NULL, 'bo legacy', $8, $9, '["workflow:read","workflow:write"]', now())`,
      [
        b,
        pa,
        hash(keys.bPinnedToPa),
        keys.bPinnedToPa.slice(0, 12),
        a,
        hash(keys.aPinnedToPa),
        keys.aPinnedToPa.slice(0, 12),
        hash(keys.bUnpinned),
        keys.bUnpinned.slice(0, 12),
      ],
    );

    // Di's workspace, made before accounts recorded user.provisioned: Ed joined as owner, removed her, invited Gus and was adopted there.
    await org(pd, 'Di', true, 90);
    await member(pd, e, 'owner', 79);
    await accepted(pd, d, e, 'e@example.com', 'owner', 79);
    await member(pd, g, 'member', 70);
    await accepted(pd, e, g, 'g@example.com', 'member', 70);
    await event(pd, e, 'user.adopted');
    // …and the workspace adopting Di's account later made her, a second one, which she invited Gus into; both pinned keys to it.
    await org(pd2, 'Di', true, 60);
    await member(pd2, d, 'owner', 60);
    await event(pd2, d, 'user.adopted');
    await member(pd2, g, 'member', 55);
    await accepted(pd2, d, g, 'g@example.com', 'member', 55);
    await sql(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $3, 'di in her second', $4, $5, '["workflow:read"]', now()),
              (gen_random_uuid(), $2, $3, 'gus in di second', $6, $7, '["workflow:read"]', now())`,
      [
        d,
        g,
        pd2,
        hash(keys.dPinnedToPd2),
        keys.dPinnedToPd2.slice(0, 12),
        hash(keys.gPinnedToPd2),
        keys.gPinnedToPd2.slice(0, 12),
      ],
    );

    // Hal's workspace, made before accounts recorded user.provisioned: Hal invited Kit as owner, and Kit's invite of Lou is stamped
    // before Kit's own accept, as an app clock stepped back stamps it.
    await org(ph, 'Hal', true, 98);
    await member(ph, h, 'owner', 98);
    await member(ph, k, 'owner', 10);
    await accepted(ph, h, k, 'k@example.com', 'owner', 10);
    await member(ph, l, 'member', 11);
    await accepted(ph, k, l, 'l@example.com', 'member', 11);

    // A personal workspace no fact names an account for.
    await org(px, 'Nobody', true, 80);

    await org(shared, 'Team', false, 30);
    await member(shared, a, 'owner', 30);
    await member(shared, b, 'member', 29);
    await sql(
      `INSERT INTO org_invites (id, org_id, email, role, token, created_by, created_at, expires_at)
       VALUES ($1, $2, 'z@example.com', 'member', $3, $4, now(), now() + interval '14 days')`,
      [ids.sharedInvite, shared, `tok_${randomUUID()}`, a],
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.all([migrated.end(), fresh.end()]);
  });

  it('keeps only each personal workspace’s owner, as owner — added back where a member removed them, never one its owner invited whatever the clock stamped — and a re-run changes nothing', async () => {
    warnings.length = 0;
    await sql(M044);
    firstRun.push(...warnings);

    expect(await membersOf(pa)).toEqual([{ user_id: a, role: 'owner' }]);
    expect(await membersOf(pd)).toEqual([{ user_id: d, role: 'owner' }]);
    expect(await membersOf(ph)).toEqual([{ user_id: h, role: 'owner' }]);
    const personal = await sql(
      `SELECT o.id, o.personal_owner_id, array_agg(m.user_id) AS members,
              bool_and(m.role = 'owner' AND m.is_personal) AS owners
         FROM organizations o LEFT JOIN org_members m ON m.org_id = o.id
        WHERE o.is_personal GROUP BY o.id`,
    );
    for (const row of personal.rows) {
      expect({ members: row.members, owners: row.owners }).toEqual({
        members: [row.personal_owner_id],
        owners: true,
      });
    }
    const ownerOf = Object.fromEntries(
      personal.rows.map((r) => [r.id as string, r.personal_owner_id as string]),
    );
    expect([pa, pb, pc, pd, pe, pg, ph, pk, pl].map((id) => ownerOf[id])).toEqual([
      a,
      b,
      c,
      d,
      e,
      g,
      h,
      k,
      l,
    ]);
    expect(await membersOf(shared)).toEqual([
      { user_id: b, role: 'member' },
      { user_id: a, role: 'owner' },
    ]);

    const settled = await rowsOf(migrated);
    warnings.length = 0;
    await sql(M044);
    expect(warnings).toEqual([]);
    expect(await rowsOf(migrated)).toEqual(settled);
    expect(await shapeOf(migrated)).toEqual(await shapeOf(fresh));
  });

  it('empties the slots others’ connections filled, revokes their keys pinned to it and deletes its pending invites, while their workflows stay in it', async () => {
    const slots = await sql(
      `SELECT environment_id, app, connection_id FROM environment_connections WHERE environment_id = ANY($1)`,
      [[ids.paProduction, ids.paStaging]],
    );
    expect(slots.rows).toEqual([
      { environment_id: ids.paProduction, app: 'gmail', connection_id: ids.aConnection },
    ]);

    const revoked = await sql(`SELECT name, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY name`);
    expect(revoked.rows).toEqual([
      { name: 'ada at home', revoked: false },
      { name: 'bo in ada', revoked: true },
      { name: 'bo legacy', revoked: false },
      { name: 'di in her second', revoked: true },
      { name: 'gus in di second', revoked: true },
    ]);

    const invites = await sql(`SELECT id, accepted_by FROM org_invites WHERE org_id = ANY($1)`, [
      [pa, shared],
    ]);
    const left = invites.rows.map((r) => r.id as string);
    expect(left).not.toContain(ids.pendingInvite);
    expect(left).not.toContain(ids.expiredInvite);
    expect(left).toContain(ids.sharedInvite);
    expect(invites.rows.filter((r) => r.accepted_by !== null)).toHaveLength(3);

    const workflows = await sql(`SELECT id, org_id FROM workflows ORDER BY name`);
    expect(workflows.rows).toEqual([
      { id: ids.bWorkflowInPb, org_id: pb },
      { id: ids.bWorkflowInPa, org_id: pa },
    ]);
  });

  it('makes a workspace no account can be shown to own, and an account’s second one, shared organizations, revoking the keys pinned to them, and gives an account left without one its own', async () => {
    const converted = await sql(
      `SELECT o.id, o.is_personal, o.personal_owner_id,
              array(SELECT m.user_id || ':' || m.role FROM org_members m WHERE m.org_id = o.id ORDER BY m.role, m.user_id) AS members
         FROM organizations o WHERE o.id = ANY($1) ORDER BY o.name`,
      [[pd2, px]],
    );
    expect(converted.rows).toEqual([
      { id: pd2, is_personal: false, personal_owner_id: null, members: [`${g}:member`, `${d}:owner`] },
      { id: px, is_personal: false, personal_owner_id: null, members: [] },
    ]);

    const given = await sql(
      `SELECT o.name, o.environments_seeded_at IS NOT NULL AS seeded,
              array(SELECT name FROM environments WHERE org_id = o.id ORDER BY name) AS environments
         FROM organizations o WHERE o.personal_owner_id = $1`,
      [f],
    );
    expect(given.rows).toEqual([
      { name: 'Fay', seeded: true, environments: ['production', 'staging', 'uat'] },
    ]);
  });

  it('names each thing it did in a warning an operator can find, and nothing else', () => {
    const uuid = '[0-9a-f-]{36}';
    const expected = [
      `044 made personal workspace Di \\(${pd2}\\) a shared organization, keeping its members: no account can be shown to own it, or its account owns an older one`,
      `044 made personal workspace Nobody \\(${px}\\) a shared organization, keeping its members: no account can be shown to own it, or its account owns an older one`,
      `044 emptied the gmail slot of environment staging in personal workspace ${pa}: it held connection ${ids.bConnection} of b@example.com, who does not own the workspace`,
      `044 emptied the slack slot of environment production in personal workspace ${pa}: it held connection ${ids.cConnection} of c@example.com, who does not own the workspace`,
      `044 revoked API key di in her second \\(${uuid}, ork_e2e_044_…\\) of d@example.com, pinned to workspace ${pd2} that is now a shared organization`,
      `044 revoked API key gus in di second \\(${uuid}, ork_e2e_044_…\\) of g@example.com, pinned to workspace ${pd2} that is now a shared organization`,
      `044 revoked API key bo in ada \\(${uuid}, ork_e2e_044_…\\) of b@example.com, pinned to personal workspace ${pa} it does not own`,
      `044 deleted the pending invite of x@example.com as member into personal workspace ${pa}`,
      `044 deleted the pending invite of y@example.com as admin into personal workspace ${pa}`,
      `044 removed b@example.com \\(${b}\\), a member as member, from personal workspace ${pa}, which it does not own; the 1 workflow\\(s\\) it created there stay in it`,
      `044 removed c@example.com \\(${c}\\), a member as owner, from personal workspace ${pa}, which it does not own; the 0 workflow\\(s\\) it created there stay in it`,
      `044 removed f@example.com \\(${f}\\), a member as admin, from personal workspace ${pa}, which it does not own; the 0 workflow\\(s\\) it created there stay in it`,
      `044 removed e@example.com \\(${e}\\), a member as owner, from personal workspace ${pd}, which it does not own; the 0 workflow\\(s\\) it created there stay in it`,
      `044 removed g@example.com \\(${g}\\), a member as member, from personal workspace ${pd}, which it does not own; the 0 workflow\\(s\\) it created there stay in it`,
      `044 removed k@example.com \\(${k}\\), a member as owner, from personal workspace ${ph}, which it does not own; the 0 workflow\\(s\\) it created there stay in it`,
      `044 removed l@example.com \\(${l}\\), a member as member, from personal workspace ${ph}, which it does not own; the 0 workflow\\(s\\) it created there stay in it`,
      `044 gave a@example.com \\(${a}\\) back the owner role in their personal workspace ${pa}`,
      `044 added d@example.com \\(${d}\\) back to their personal workspace ${pd}, as its owner`,
      `044 gave f@example.com \\(${f}\\) a personal workspace of its own, ${uuid}: it had none`,
    ];
    const unmatched = firstRun.filter(
      (line) => !expected.some((pattern) => new RegExp(`^${pattern}$`).test(line)),
    );
    expect(unmatched).toEqual([]);
    expect(firstRun).toHaveLength(expected.length);
  });

  describe('the service on the migrated database', () => {
    let app: INestApplication;
    let restoreEnv: () => void;
    const session = async (userId: string): Promise<string> =>
      (await mintSession(userId, SSO_SECRET_KEY)).token;
    const as = (bearer: string, r: request.Test): request.Test => r.set('Authorization', `Bearer ${bearer}`);
    const orgOfWorkflow = async (id: string): Promise<string> =>
      (await sql(`SELECT org_id FROM workflows WHERE id = $1`, [id])).rows[0]!.org_id as string;

    beforeAll(async () => {
      restoreEnv = snapshotEnv();
      app = await bootSsoApp(databaseUrl, { LOCAL_AUTH_ENABLED: 'true' });
    }, 30_000);

    afterAll(async () => {
      await app?.close();
      restoreEnv();
    });

    it('lands a former member of another’s personal workspace in their own, without a header, as its owner, and pins their new key there', async () => {
      const bo = await session(b);
      for (const bearer of [bo, keys.bUnpinned]) {
        const listed = await as(bearer, from(app).get('/api/orgs')).expect(200);
        expect(listed.body.orgs).toEqual([
          { id: pb, name: 'Bo', is_personal: true, role: 'owner' },
          { id: shared, name: 'Team', is_personal: false, role: 'member' },
        ]);
        for (let i = 0; i < 5; i++) {
          const mine = await as(bearer, from(app).get('/api/workflows')).expect(200);
          expect(mine.body.workflows.map((w: { id: string }) => w.id)).toEqual([ids.bWorkflowInPb]);
        }
      }
      const made = await as(bo, from(app).post('/api/deploy'))
        .send({ workflow_json: webhookDoc('made at home') })
        .expect(201);
      expect(made.body.is_live).toBe(true);
      expect(await orgOfWorkflow(made.body.workflow_id as string)).toBe(pb);
      const env = await as(bo, from(app).post('/api/environments')).send({ name: 'qa' }).expect(201);
      expect((await sql(`SELECT org_id FROM environments WHERE id = $1`, [env.body.id])).rows).toEqual([
        { org_id: pb },
      ]);

      const key = await as(bo, from(app).post('/api/api-keys'))
        .send({ name: 'ci', scopes: ['workflow:read'] })
        .expect(201);
      expect((await sql(`SELECT org_id FROM api_keys WHERE id = $1`, [key.body.id])).rows).toEqual([
        { org_id: pb },
      ]);
      await as(keys.bPinnedToPa, from(app).get('/api/orgs')).expect(401);
      await as(bo, from(app).get('/api/workflows').set('X-Org-Id', pa)).expect(403);
    });

    it('refuses every key pinned to a workspace it made a shared organization, its holder’s and a member’s alike', async () => {
      for (const revoked of [keys.dPinnedToPd2, keys.gPinnedToPd2]) {
        await as(revoked, from(app).get('/api/workflows')).expect(401);
      }
      await as(await session(d), from(app).get('/api/workflows').set('X-Org-Id', pd2)).expect(200);
    });

    it('gives the owner back their workspace as its owner, holding the workflow a removed member made there, and an account the upgrade gave one lands in it', async () => {
      const ada = await session(a);
      const env = await as(ada, from(app).post('/api/environments')).send({ name: 'qa' }).expect(201);
      expect((await sql(`SELECT org_id FROM environments WHERE id = $1`, [env.body.id])).rows).toEqual([
        { org_id: pa },
      ]);
      const listed = await as(ada, from(app).get('/api/workflows')).expect(200);
      expect(listed.body.workflows.map((w: { id: string }) => w.id)).toEqual([ids.bWorkflowInPa]);

      const fay = await session(f);
      const own = (await sql(`SELECT id FROM organizations WHERE personal_owner_id = $1`, [f])).rows[0]!
        .id as string;
      const made = await as(fay, from(app).post('/api/deploy'))
        .send({ workflow_json: webhookDoc('Fay at home') })
        .expect(201);
      expect(await orgOfWorkflow(made.body.workflow_id as string)).toBe(own);
      const key = await as(fay, from(app).post('/api/api-keys'))
        .send({ name: 'ci', scopes: ['workflow:read'] })
        .expect(201);
      expect((await sql(`SELECT org_id FROM api_keys WHERE id = $1`, [key.body.id])).rows).toEqual([
        { org_id: own },
      ]);
    });
  });
});

/** 044 beside a write under an org, which holds the org row and then writes under it (constitution row 20), and beside an admission, which holds the admission lock and then writes a user and reads the org. Scratch DBs. */
describe('migration 044 beside a write under an org (scratch DBs)', () => {
  const waitingOnLock = async (db: Client, pid: number): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
        [pid],
      );
      if (rows.length > 0) return;
      await pause(25);
    }
    throw new Error('044 never waited on a lock');
  };
  const locksOf = async (db: Client, pid: number): Promise<unknown[]> =>
    (
      await db.query(
        `SELECT coalesce(c.relname, l.locktype) AS lock, l.mode, l.granted
           FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = $1 AND l.locktype IN ('relation', 'advisory')
          ORDER BY 1, 2`,
        [pid],
      )
    ).rows;
  const outcome = (query: Promise<unknown>): Promise<string> =>
    query.then(
      () => 'landed',
      (err: Error) => err.message,
    );

  interface Seed {
    owner: string;
    team: string;
    environment: string;
    connection: string;
  }
  const UNDER_THE_ORG = [
    { lock: 'advisory', mode: 'ExclusiveLock', granted: true },
    { lock: 'organizations', mode: 'AccessExclusiveLock', granted: false },
  ];
  const WRITES: Array<{
    write: string;
    holds: (db: Client, seed: Seed) => Promise<unknown>;
    then: (db: Client, seed: Seed) => Promise<unknown>;
    waits: unknown[];
    landed: (db: Client, seed: Seed) => Promise<unknown[]>;
  }> = [
    {
      write: 'an invite',
      holds: (db, { team }) => db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`, [team]),
      then: (db, { team, owner }) =>
        db.query(
          `INSERT INTO org_invites (id, org_id, email, role, token, created_by, created_at, expires_at)
           VALUES (gen_random_uuid(), $1, 'x@example.com', 'member', $2, $3, now(), now() + interval '14 days')`,
          [team, `tok_${randomUUID()}`, owner],
        ),
      waits: UNDER_THE_ORG,
      landed: async (db, { team }) =>
        (await db.query(`SELECT email FROM org_invites WHERE org_id = $1`, [team])).rows,
    },
    {
      write: 'an accept',
      holds: (db, { team }) => db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`, [team]),
      then: async (db, { team }) => {
        const joiner = randomUUID();
        await db.query(`SELECT user_id FROM org_members WHERE org_id = $1`, [team]);
        await db.query(
          `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'j@example.com', 'J', now(), now())`,
          [joiner],
        );
        await db.query(
          `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
          [team, joiner],
        );
      },
      waits: UNDER_THE_ORG,
      landed: async (db, { team }) =>
        (await db.query(`SELECT role FROM org_members WHERE org_id = $1`, [team])).rows,
    },
    {
      write: 'a slot assign',
      holds: (db, { team }) => db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`, [team]),
      then: async (db, { environment, connection }) => {
        await db.query(`SELECT 1 FROM environments WHERE id = $1 FOR KEY SHARE`, [environment]);
        await db.query(`SELECT 1 FROM connections WHERE id = $1 FOR KEY SHARE`, [connection]);
        await db.query(
          `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'gmail', $2)`,
          [environment, connection],
        );
      },
      waits: UNDER_THE_ORG,
      landed: async (db, { environment }) =>
        (await db.query(`SELECT app FROM environment_connections WHERE environment_id = $1`, [environment]))
          .rows,
    },
    {
      write: 'a password reset',
      holds: (db, { owner }) =>
        db.query(`UPDATE users SET hashed_password = 'reset', updated_at = now() WHERE id = $1`, [owner]),
      then: () => Promise.resolve(),
      waits: [
        { lock: 'advisory', mode: 'ExclusiveLock', granted: true },
        { lock: 'org_members', mode: 'AccessExclusiveLock', granted: true },
        { lock: 'organizations', mode: 'AccessExclusiveLock', granted: true },
        { lock: 'users', mode: 'ShareRowExclusiveLock', granted: false },
      ],
      landed: async (db, { owner }) =>
        (await db.query(`SELECT 1 FROM users WHERE id = $1 AND hashed_password = 'reset'`, [owner])).rows,
    },
    {
      write: 'an admission',
      holds: (db) => db.query(`SELECT pg_advisory_xact_lock(7302, 0)`),
      then: async (db, { team }) => {
        await db.query(
          `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'n@example.com', 'N', now(), now())`,
          [randomUUID()],
        );
        await db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`, [team]);
      },
      waits: [{ lock: 'advisory', mode: 'ExclusiveLock', granted: false }],
      landed: async (db) => (await db.query(`SELECT name FROM users WHERE email = 'n@example.com'`)).rows,
    },
  ];

  describe.each([
    ['upgrading a database it has not reached', true],
    ['on every boot after', false],
  ])('%s', (_when, upgrading) => {
    it.each(WRITES)(
      'waits for $write, holding no lock it would then need, and both land',
      async ({ holds, then, waits, landed }) => {
        const url = await createE2eDatabase(ADMIN_URL);
        const writer = new Client({ connectionString: url });
        const migration = new Client({ connectionString: url });
        const observer = new Client({ connectionString: url });
        await Promise.all([writer.connect(), migration.connect(), observer.connect()]);
        try {
          if (upgrading) await undo044(observer);
          const seed: Seed = {
            owner: randomUUID(),
            team: randomUUID(),
            environment: randomUUID(),
            connection: randomUUID(),
          };
          await observer.query(
            `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'o@example.com', 'O', now(), now())`,
            [seed.owner],
          );
          await observer.query(
            `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Team', false, now(), now())`,
            [seed.team],
          );
          await observer.query(
            `INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $2, 'production', true)`,
            [seed.environment, seed.team],
          );
          await observer.query(
            `INSERT INTO connections (id, user_id, provider, auth_type, credential) VALUES ($1, $2, 'gmail', 'token', 'x')`,
            [seed.connection, seed.owner],
          );
          const pid = (await migration.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

          await writer.query('BEGIN');
          await holds(writer, seed);
          const migrating = outcome(migration.query(M044));
          await waitingOnLock(observer, pid);
          expect(await locksOf(observer, pid)).toEqual(waits);
          const wrote = await outcome(then(writer, seed));
          await writer.query(wrote === 'landed' ? 'COMMIT' : 'ROLLBACK');

          expect({ wrote, migrated: await migrating }).toEqual({ wrote: 'landed', migrated: 'landed' });
          expect(await landed(observer, seed)).toHaveLength(1);
        } finally {
          await Promise.all([writer.end(), migration.end(), observer.end()]);
        }
      },
    );
  });
});
