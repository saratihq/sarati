import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import type request from 'supertest';

import { KEY_SCOPED_TO_OTHER_ORG } from '../src/auth/principal';
import { keyHash } from './support/api-keys';
import { webhookDoc } from './support/golden-docs';
import { pause } from './support/lock-probes';
import { insertPersonalOrgs } from './support/personal-org';
import { THIS_SERVICE } from './support/service-process';
import { bootSsoApp, from, snapshotEnv } from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M046 = readFileSync(join(__dirname, '..', 'db', 'migrations', '046_api_keys_pinned.sql'), 'utf8');

const ORG_ID = `SELECT is_nullable FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'org_id'`;

/** What the image runs before the service: every migration, in order, on the database; what it printed. */
async function migrate(databaseUrl: string): Promise<string[]> {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/migrate-db.mjs'], {
    cwd: THIS_SERVICE,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return `${stdout}${stderr}`.split('\n');
}

const upgradeLines = (out: string[]): string[] => out.filter((line) => /^04[46] /.test(line));

/** 046 on keys an earlier release left unpinned, through `db:migrate`, which re-runs it on every boot. Scratch DBs. */
describe('migration 046: every API key acts in one org, an unpinned one pinned to its owner’s personal workspace (scratch DBs)', () => {
  let databaseUrl = '';
  let db: Client;
  let fresh: Client;

  const ada = randomUUID();
  const bo = randomUUID();
  const adaHome = randomUUID();
  const team = randomUUID();
  const teamFlow = randomUUID();
  const orglessFlow = randomUUID();
  const keys = {
    adaLegacy: 'ork_e2e_046_ada_legacy_aaaaaaaaaaaaaaaa',
    adaRevoked: 'ork_e2e_046_ada_revoked_bbbbbbbbbbbbbbb',
    adaExpired: 'ork_e2e_046_ada_expired_ccccccccccccccc',
    adaInTeam: 'ork_e2e_046_ada_in_team_ddddddddddddddd',
    boLegacy: 'ork_e2e_046_bo_legacy_eeeeeeeeeeeeeeeeee',
  };
  let firstRun: string[] = [];

  const keyRows = async (): Promise<unknown[]> =>
    (await db.query(`SELECT name, org_id, revoked_at, expires_at, scopes::text FROM api_keys ORDER BY name`))
      .rows;
  const boHome = async (): Promise<string> =>
    (await db.query<{ id: string }>(`SELECT id FROM organizations WHERE personal_owner_id = $1`, [bo]))
      .rows[0]!.id;

  beforeAll(async () => {
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    fresh = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await Promise.all([db.connect(), fresh.connect()]);

    // The column as every release before 046 left it.
    await db.query(`ALTER TABLE api_keys ALTER COLUMN org_id DROP NOT NULL`);
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'a@example.com', 'Ada', now(), now()), ($2, 'b@example.com', 'Bo', now(), now())`,
      [ada, bo],
    );
    await insertPersonalOrgs(db, { id: adaHome, userId: ada, name: 'Ada' });
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Team', false, now(), now())`,
      [team],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $1, $3, 'member', now())`,
      [team, ada, bo],
    );
    await db.query(
      `INSERT INTO workflows (id, name, user_id, org_id) VALUES ($1, 'Team Flow', $3, $4), ($2, 'Orgless Flow', $3, NULL)`,
      [teamFlow, orglessFlow, ada, team],
    );
    const insertKey = (
      userId: string,
      orgId: string | null,
      name: string,
      key: string,
      extra: { revoked?: boolean; expired?: boolean; scopes?: string } = {},
    ) =>
      db.query(
        `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at, revoked_at, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::json, now(),
                 CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() - interval '1 day' END)`,
        [
          userId,
          orgId,
          name,
          keyHash(key),
          key.slice(0, 12),
          extra.scopes ?? '["workflow:read"]',
          extra.revoked ?? false,
          extra.expired ?? false,
        ],
      );
    // A key from before keys carried scopes: full authority, and no org.
    await insertKey(ada, null, 'ada legacy', keys.adaLegacy, { scopes: 'null' });
    await insertKey(ada, null, 'ada revoked', keys.adaRevoked, { revoked: true });
    await insertKey(ada, null, 'ada expired', keys.adaExpired, { expired: true });
    await insertKey(ada, team, 'ada in team', keys.adaInTeam);
    await insertKey(bo, null, 'bo legacy', keys.boLegacy);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([db.end(), fresh.end()]);
  });

  it('pins each unpinned key to its owner’s personal workspace — a revoked or expired one too, and an account’s with none to the one 044 gives it — and a re-run changes nothing', async () => {
    const before = await keyRows();
    firstRun = await migrate(databaseUrl);
    const home = await boHome();

    const after = (await keyRows()) as Array<Record<string, unknown>>;
    expect(after.map(({ name, org_id }) => [name, org_id])).toEqual([
      ['ada expired', adaHome],
      ['ada in team', team],
      ['ada legacy', adaHome],
      ['ada revoked', adaHome],
      ['bo legacy', home],
    ]);
    expect(after.map(({ org_id: _org, ...rest }) => rest)).toEqual(
      (before as Array<Record<string, unknown>>).map(({ org_id: _org, ...rest }) => rest),
    );

    const settled = await keyRows();
    const again = await migrate(databaseUrl);
    expect(upgradeLines(again)).toEqual([]);
    expect(await keyRows()).toEqual(settled);
  });

  it('names each live key it pinned in a warning, and nothing else', () => {
    const uuid = '[0-9a-f-]{36}';
    const expected = [
      `044 gave b@example\\.com \\(${bo}\\) a personal workspace of its own, ${uuid}: it had none`,
      `046 pinned API key ada legacy \\(${uuid}, ork_e2e_046_…\\) of a@example\\.com to their personal workspace ${adaHome}: it reached every organization they belong to, and now acts only there`,
      `046 pinned API key bo legacy \\(${uuid}, ork_e2e_046_…\\) of b@example\\.com to their personal workspace ${uuid}: it reached every organization they belong to, and now acts only there`,
    ];
    const lines = upgradeLines(firstRun);
    expect(
      lines.filter((line) => !expected.some((pattern) => new RegExp(`^${pattern}$`).test(line))),
    ).toEqual([]);
    expect(lines).toHaveLength(expected.length);
  });

  it('leaves the column NOT NULL, as a fresh schema has it, so the database refuses an unpinned key', async () => {
    expect((await db.query(ORG_ID)).rows).toEqual([{ is_nullable: 'NO' }]);
    expect((await db.query(ORG_ID)).rows).toEqual((await fresh.query(ORG_ID)).rows);
    await expect(
      db.query(
        `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, created_at)
         VALUES (gen_random_uuid(), $1, NULL, 'unpinned', 'h', 'ork_e2e_046_', now())`,
        [ada],
      ),
    ).rejects.toThrow(/null value in column "org_id" of relation "api_keys" violates not-null constraint/);
  });

  describe('the service on the upgraded database', () => {
    let app: INestApplication;
    let restoreEnv: () => void;
    const as = (key: string, r: request.Test): request.Test => r.set('Authorization', `Bearer ${key}`);
    const orgsOf = async (key: string): Promise<string[]> =>
      ((await as(key, from(app).get('/api/orgs')).expect(200)).body.orgs as Array<{ id: string }>).map(
        (o) => o.id,
      );

    beforeAll(async () => {
      restoreEnv = snapshotEnv();
      app = await bootSsoApp(databaseUrl, {});
    }, 30_000);

    afterAll(async () => {
      await app?.close();
      restoreEnv();
    });

    it('a key that was unpinned acts in its owner’s personal workspace, and is refused a team org its owner belongs to and a workflow in none', async () => {
      await as(keys.adaLegacy, from(app).get('/api/workflows')).expect(200);
      const refused = await as(keys.adaLegacy, from(app).get('/api/workflows').set('X-Org-Id', team)).expect(
        403,
      );
      expect(refused.body.detail).toBe(KEY_SCOPED_TO_OTHER_ORG);
      await as(keys.adaLegacy, from(app).get(`/api/workflows/${teamFlow}`)).expect(404);
      await as(keys.adaLegacy, from(app).get(`/api/workflows/${orglessFlow}`)).expect(404);
      expect(await orgsOf(keys.adaLegacy)).toEqual([adaHome]);

      const made = await as(keys.adaLegacy, from(app).post('/api/deploy'))
        .send({ workflow_json: webhookDoc('made by a legacy key') })
        .expect(201);
      expect(
        (await db.query(`SELECT org_id FROM workflows WHERE id = $1`, [made.body.workflow_id])).rows,
      ).toEqual([{ org_id: adaHome }]);
    });

    it('an account’s key pinned to the workspace 044 gave it acts there and nowhere else', async () => {
      const home = await boHome();
      expect(await orgsOf(keys.boLegacy)).toEqual([home]);
      await as(keys.boLegacy, from(app).get('/api/workflows').set('X-Org-Id', home)).expect(200);
      await as(keys.boLegacy, from(app).get('/api/workflows').set('X-Org-Id', team)).expect(403);
    });

    it('a key already pinned to a team org still acts there, and a revoked or expired one nowhere', async () => {
      expect(await orgsOf(keys.adaInTeam)).toEqual([team]);
      await as(keys.adaInTeam, from(app).get(`/api/workflows/${teamFlow}`)).expect(200);
      await as(keys.adaInTeam, from(app).get('/api/workflows').set('X-Org-Id', adaHome)).expect(403);
      for (const dead of [keys.adaRevoked, keys.adaExpired]) {
        await as(dead, from(app).get('/api/workflows')).expect(401);
      }
    });
  });
});

/** 046 beside a key an earlier release, still running, is issuing as the upgrade starts. Scratch DB. */
describe('migration 046 beside a key being issued (scratch DB)', () => {
  it('waits for the key, pins it with the rest, and only then holds every key to an org', async () => {
    const url = await createE2eDatabase(ADMIN_URL);
    const writer = new Client({ connectionString: url });
    const migration = new Client({ connectionString: url });
    const observer = new Client({ connectionString: url });
    await Promise.all([writer.connect(), migration.connect(), observer.connect()]);
    try {
      const owner = randomUUID();
      const home = randomUUID();
      await observer.query(`ALTER TABLE api_keys ALTER COLUMN org_id DROP NOT NULL`);
      await observer.query(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'w@example.com', 'W', now(), now())`,
        [owner],
      );
      await insertPersonalOrgs(observer, { id: home, userId: owner, name: 'W' });
      const pid = (await migration.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;

      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, created_at)
         VALUES (gen_random_uuid(), $1, NULL, 'being issued', 'h', 'ork_e2e_046_', now())`,
        [owner],
      );
      const migrating = migration.query(M046).then(
        () => 'landed',
        (err: Error) => err.message,
      );
      for (let i = 0; i < 200; i++) {
        const { rows } = await observer.query(
          `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
          [pid],
        );
        if (rows.length > 0) break;
        if (i === 199) throw new Error('046 never waited on the key being issued');
        await pause(25);
      }
      await writer.query('COMMIT');

      expect(await migrating).toBe('landed');
      expect((await observer.query(`SELECT name, org_id FROM api_keys`)).rows).toEqual([
        { name: 'being issued', org_id: home },
      ]);
      expect((await observer.query(ORG_ID)).rows).toEqual([{ is_nullable: 'NO' }]);
    } finally {
      await Promise.all([writer.end(), migration.end(), observer.end()]);
    }
  });
});
