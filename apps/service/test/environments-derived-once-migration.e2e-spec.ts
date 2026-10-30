import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { insertPersonalOrgs } from './support/personal-org';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const SERVICE = join(__dirname, '..');
const REPO = join(SERVICE, '..', '..');
const TABLES = ['environments', 'environment_connections', 'workflow_env_pointers', 'runtime_runs'];
const CLEAN = { code: 0, stderr: '' };

/** `db:migrate` as the container entrypoint runs it on every boot. */
const migrate = (url: string): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SERVICE, 'scripts', 'migrate-db.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stderr }));
  });

async function connect(url: string): Promise<Client> {
  const db = new Client({ connectionString: url });
  await db.connect();
  return db;
}

/** Columns, constraints and indexes of the tables 006 makes or changes, so a migrated database can be compared with a fresh one. */
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
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

/** Every row 006 derives from or writes, so a later run can be shown to change none of them. */
async function rowsOf(db: Client): Promise<unknown> {
  const all = async (sql: string): Promise<unknown[]> => (await db.query(sql)).rows;
  return {
    environments: await all(`SELECT id, org_id, name, is_prod FROM environments ORDER BY id`),
    slots: await all(`SELECT environment_id, app, connection_id FROM environment_connections ORDER BY 1, 2`),
    pointers: await all(
      `SELECT workflow_id, environment, environment_id, version_id FROM workflow_env_pointers ORDER BY 1, 2`,
    ),
    connections: await all(`SELECT id, org_id, environment FROM connections ORDER BY id`),
    organizations: await all(`SELECT id, environments_seeded_at FROM organizations ORDER BY id`),
  };
}

/** The org's environments by name, each with its slots as `app → connection`. */
async function environmentsOf(db: Client, orgId: string): Promise<Record<string, Record<string, string>>> {
  const { rows } = await db.query<{ name: string; app: string | null; connection_id: string | null }>(
    `SELECT e.name, ec.app, ec.connection_id
       FROM environments e LEFT JOIN environment_connections ec ON ec.environment_id = e.id
      WHERE e.org_id = $1 ORDER BY e.name, ec.app`,
    [orgId],
  );
  const envs: Record<string, Record<string, string>> = {};
  for (const { name, app, connection_id } of rows) {
    envs[name] ??= {};
    if (app && connection_id) envs[name][app] = connection_id;
  }
  return envs;
}

/** A user, a shared org it owns, and a cluster connection an earlier release made for each tag, by SQL as that release wrote them. */
async function seedOrg(
  db: Client,
  clusterTags: string[],
): Promise<{ user: string; org: string; clusters: string[] }> {
  const user = randomUUID();
  const org = randomUUID();
  await db.query(
    `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, 'Derived Once', now(), now())`,
    [user, `${user}@e2e.local`],
  );
  await insertPersonalOrg(db, user);
  await db.query(
    `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Derived Once', false, now(), now())`,
    [org],
  );
  await db.query(
    `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
    [org, user],
  );
  const clusters = await insertClusters(db, user, org, clusterTags);
  return { user, org, clusters };
}

/** The user's personal workspace as the schema in `db` holds one: before 044, a personal org and the user's membership; from it, the org naming its owner. */
async function insertPersonalOrg(db: Client, user: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'personal_owner_id'`,
  );
  if (rows.length > 0) return insertPersonalOrgs(db, { id: randomUUID(), userId: user, name: 'Personal' });
  const org = randomUUID();
  await db.query(
    `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Personal', true, now(), now())`,
    [org],
  );
  await db.query(
    `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
    [org, user],
  );
}

async function insertClusters(db: Client, user: string, org: string, tags: string[]): Promise<string[]> {
  const ids = tags.map(() => randomUUID());
  await db.query(
    `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
     SELECT id, $2, 'slack', 'managed', 'enc', now(), 'active', $3, tag
       FROM unnest($1::uuid[], $4::text[]) AS c(id, tag)`,
    [ids, user, org, tags],
  );
  return ids;
}

const git = (...args: string[]): string => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

/** Every `v*` release this build's history holds, oldest first. */
function releases(): string[] {
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=v:refname').split('\n').filter(Boolean);
  if (tags.length === 0)
    throw new Error('No v* release tag in this clone: fetch the tags (git fetch --tags)');
  return tags;
}

/** Migration 006 derives environments and slots from the legacy name strings once, in the statement that creates `environments`, never on a later boot (constitution row 7). Scratch DBs. */
describe('migration 006 derives environments once (scratch DBs)', () => {
  let freshShape: unknown;
  const opened: Client[] = [];
  const open = async (url: string): Promise<Client> => {
    const db = await connect(url);
    opened.push(db);
    return db;
  };

  beforeAll(async () => {
    const url = await createE2eDatabase(ADMIN_URL);
    expect(await migrate(url)).toEqual(CLEAN);
    freshShape = await shapeOf(await open(url));
  }, 60_000);

  afterAll(async () => {
    for (const db of opened) await db.end();
  });

  describe('a database from before 006', () => {
    let url = '';
    let db: Client;
    let seeded: { user: string; org: string; clusters: string[] };
    const workflow = randomUUID();
    const version = randomUUID();

    beforeAll(async () => {
      url = await createE2eDatabase(ADMIN_URL);
      db = await open(url);
      seeded = await seedOrg(db, ['prod', 'staging', 'qa']);
      for (const statement of [
        `DROP TABLE public.webhook_trigger_secrets`,
        `DROP TABLE public.runtime_activation_store`,
        `DROP TABLE public.runtime_trigger_activations`,
        `ALTER TABLE public.workflow_env_pointers DROP COLUMN environment_id`,
        `ALTER TABLE public.runtime_runs DROP COLUMN environment_id`,
        `DROP TABLE public.environment_connections`,
        `DROP TABLE public.environments`,
        `ALTER TABLE public.organizations DROP COLUMN environments_seeded_at`,
      ]) {
        await db.query(statement);
      }
      await db.query(
        `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
         VALUES ($1, 'derived', 'generated', $2, $3, now(), now())`,
        [workflow, seeded.user, seeded.org],
      );
      await db.query(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, created_at)
         VALUES ($1, $2, 1, '{}', now())`,
        [version, workflow],
      );
      await db.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [workflow, version]);
      await db.query(
        `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id) VALUES ($1, 'prod', $2), ($1, 'staging', $2)`,
        [workflow, version],
      );
    }, 60_000);

    it('the first run of the whole chain derives environments and slots from the legacy strings', async () => {
      expect(await migrate(url)).toEqual(CLEAN);

      const [prod, staging, qa] = seeded.clusters;
      expect(await environmentsOf(db, seeded.org)).toEqual({
        production: { slack: prod },
        qa: { slack: qa },
        staging: { slack: staging },
        uat: {},
      });
      const pointers = await db.query(
        `SELECT p.environment, e.name AS env FROM workflow_env_pointers p JOIN environments e ON e.id = p.environment_id
          WHERE p.workflow_id = $1 ORDER BY p.environment`,
        [workflow],
      );
      expect(pointers.rows).toEqual([
        { environment: 'production', env: 'production' },
        { environment: 'staging', env: 'staging' },
      ]);
      expect(await shapeOf(db)).toEqual(freshShape);
    }, 60_000);

    it('a second run, after the owner deletes staging, renames qa, empties a slot and an earlier release cluster-connects to names with no environment, brings none of it back and changes no row', async () => {
      const production = await db.query<{ id: string }>(
        `SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`,
        [seeded.org],
      );
      await db.query(`DELETE FROM environments WHERE org_id = $1 AND name = 'staging'`, [seeded.org]);
      await db.query(`UPDATE environments SET name = 'qa-two' WHERE org_id = $1 AND name = 'qa'`, [
        seeded.org,
      ]);
      await db.query(`DELETE FROM environment_connections WHERE environment_id = $1 AND app = 'slack'`, [
        production.rows[0]!.id,
      ]);
      await insertClusters(db, seeded.user, seeded.org, ['ghost', 'default', 'Staging']);
      const before = await rowsOf(db);

      expect(await migrate(url)).toEqual(CLEAN);

      expect(await rowsOf(db)).toEqual(before);
      expect(await environmentsOf(db, seeded.org)).toEqual({
        production: {},
        'qa-two': { slack: seeded.clusters[2] },
        uat: {},
      });
      expect(await shapeOf(db)).toEqual(freshShape);
    }, 60_000);
  });

  describe("an upgrade from a release's schema", () => {
    let dir = '';

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'sarati-schemas-'));
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it.each([...releases(), 'this build'])(
      "from %s converges with a fresh install and derives nothing from a cluster connection's name",
      async (release) => {
        let schema: string | undefined;
        if (release !== 'this build') {
          schema = join(dir, `${release}.sql`);
          writeFileSync(schema, git('show', `${release}:apps/service/db/schema.sql`));
        }
        const url = await createE2eDatabase(ADMIN_URL, schema);
        const db = await open(url);
        const { org } = await seedOrg(db, ['ghost']);

        expect(await migrate(url)).toEqual(CLEAN);
        const first = await rowsOf(db);
        expect(await migrate(url)).toEqual(CLEAN);

        expect(await rowsOf(db)).toEqual(first);
        expect(Object.keys(await environmentsOf(db, org))).toEqual(['production', 'staging', 'uat']);
        expect(await shapeOf(db)).toEqual(freshShape);
      },
      60_000,
    );
  });

  describe("the service's own edits, then a restart", () => {
    const key = 'ork_e2e_derived_once_aaaaaaaaaaaaaaaaaa';
    const user = randomUUID();
    let url = '';
    let db: Client;
    let app: INestApplication | undefined;

    const http = (): ReturnType<typeof request> => request(app!.getHttpServer());
    const as = (r: request.Test, org: string): request.Test =>
      r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', org);

    const boot = async (): Promise<void> => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
      configureApp(app);
      await app.init();
      await listenOnLoopback(app);
    };

    const shut = async (): Promise<void> => {
      await app?.close();
      app = undefined;
    };

    beforeAll(async () => {
      url = await createE2eDatabase(ADMIN_URL);
      db = await open(url);
      await db.query(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'derived-once@e2e.local', 'Derived', now(), now())`,
        [user],
      );
      await insertPersonalOrgs(db, { id: randomUUID(), userId: user, name: 'Derived' });
      await db.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'k', $2, $3, now())`,
        [user, createHash('sha256').update(key, 'utf8').digest('hex'), key.slice(0, 12)],
      );
      process.env.DATABASE_URL = url;
      process.env.PGBOSS_ENABLED = 'false';
      process.env.MOCK_AUTH = 'false';
      process.env.CLERK_ISSUER = '';
      process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    }, 60_000);

    afterAll(async () => {
      await shut();
      process.env.DATABASE_URL = ADMIN_URL;
    });

    it('a restart brings back no environment or slot its owner removed, whatever cluster connections still name', async () => {
      await boot();
      const created = await http()
        .post('/api/orgs')
        .set('Authorization', `Bearer ${key}`)
        .send({ name: 'Restarts' })
        .expect(201);
      const org = created.body.id as string;
      await as(http().post('/api/environments'), org).send({ name: 'qa' }).expect(201);
      const [staging, qa, production] = await insertClusters(db, user, org, ['staging', 'qa', 'production']);
      const envId = async (name: string): Promise<string> =>
        (
          await db.query<{ id: string }>(`SELECT id FROM environments WHERE org_id = $1 AND name = $2`, [
            org,
            name,
          ])
        ).rows[0]!.id;
      for (const [name, connection] of [
        ['staging', staging],
        ['qa', qa],
        ['production', production],
      ] as const) {
        await as(http().put(`/api/environments/${await envId(name)}/slots/slack`), org)
          .send({ connection_id: connection })
          .expect(200);
      }
      await as(http().delete(`/api/environments/${await envId('staging')}`), org).expect(200);
      await as(http().patch(`/api/environments/${await envId('qa')}`), org)
        .send({ name: 'qa-two' })
        .expect(200);
      await as(http().delete(`/api/environments/${await envId('production')}/slots/slack`), org).expect(200);
      const before = await rowsOf(db);
      await shut();

      expect(await migrate(url)).toEqual(CLEAN);
      await boot();

      const listed = await as(http().get('/api/environments'), org).expect(200);
      expect(
        (
          listed.body.environments as Array<{
            name: string;
            slots: Array<{ app: string; connection_id: string }>;
          }>
        ).map((e) => ({ name: e.name, slots: e.slots.map((s) => [s.app, s.connection_id]) })),
      ).toEqual([
        { name: 'production', slots: [] },
        { name: 'qa-two', slots: [['slack', qa]] },
        { name: 'uat', slots: [] },
      ]);
      expect(await rowsOf(db)).toEqual(before);
    }, 60_000);
  });
});
