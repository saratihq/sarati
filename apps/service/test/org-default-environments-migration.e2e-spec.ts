import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { DEFAULT_ENVS, seedDefaultEnvironments } from '../src/environments/default-environments';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M042 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '042_org_default_environments.sql'),
  'utf8',
);

/** 042 gives an org an earlier version never listed its default environments, once; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 042: an org gets its default environments once (scratch DB)', () => {
  let db: Client;
  const [neverListed, published, stagingDeleted, stagingRenamed, intact, marked] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];

  const org = (id: string) =>
    db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'o', false, now(), now())`,
      [id],
    );
  const envs = (id: string, ...names: string[]) =>
    db.query(
      `INSERT INTO environments (org_id, name, is_prod) SELECT $1, name, name = 'production' FROM unnest($2::text[]) AS name`,
      [id, names],
    );
  const envsOf = async (id: string): Promise<Array<{ id: string; name: string; is_prod: boolean }>> =>
    (
      await db.query<{ id: string; name: string; is_prod: boolean }>(
        `SELECT id, name, is_prod FROM environments WHERE org_id = $1 ORDER BY name`,
        [id],
      )
    ).rows;
  const namesOf = async (id: string): Promise<string[]> => (await envsOf(id)).map((e) => e.name);
  const everyOrgsEnvs = async (): Promise<unknown[]> => {
    const all = [];
    for (const id of [neverListed, published, stagingDeleted, stagingRenamed, intact, marked])
      all.push(await envsOf(id));
    return all;
  };
  const unseeded = async (): Promise<number> =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM organizations WHERE environments_seeded_at IS NULL`,
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('ALTER TABLE organizations DROP COLUMN environments_seeded_at');
    for (const id of [neverListed, published, stagingDeleted, stagingRenamed, intact]) await org(id);
    await envs(published, 'production');
    await envs(stagingDeleted, 'production', 'uat');
    await envs(stagingRenamed, 'production', 'preview', 'uat');
    await envs(intact, 'production', 'staging', 'uat');
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it("seeds only an org an earlier version never listed, keeps every row it had, and leaves a listed org's missing staging missing", async () => {
    const before = {
      published: await envsOf(published),
      stagingDeleted: await envsOf(stagingDeleted),
      stagingRenamed: await envsOf(stagingRenamed),
      intact: await envsOf(intact),
    };
    await db.query(M042);

    expect(await envsOf(neverListed)).toEqual(
      [...DEFAULT_ENVS]
        .sort()
        .map((name) => ({ id: expect.any(String), name, is_prod: name === 'production' })),
    );
    expect(await envsOf(published)).toEqual(
      expect.arrayContaining(before.published.map((row) => expect.objectContaining(row))),
    );
    expect(await namesOf(published)).toEqual(['production', 'staging', 'uat']);
    expect(await envsOf(stagingDeleted)).toEqual(before.stagingDeleted);
    expect(await envsOf(stagingRenamed)).toEqual(before.stagingRenamed);
    expect(await envsOf(intact)).toEqual(before.intact);
    expect(await unseeded()).toBe(0);
  });

  it('a re-run brings back no staging deleted or renamed since, and seeds no org that has its marker', async () => {
    await db.query(`DELETE FROM environments WHERE org_id = $1 AND name = 'staging'`, [neverListed]);
    await db.query(`UPDATE environments SET name = 'qa' WHERE org_id = $1 AND name = 'staging'`, [published]);
    await org(marked);
    await seedDefaultEnvironments(db, marked);
    await db.query(`DELETE FROM environments WHERE org_id = $1 AND name <> 'production'`, [marked]);
    const settled = await everyOrgsEnvs();

    await db.query(M042);
    await db.query(M042);

    expect(await everyOrgsEnvs()).toEqual(settled);
    expect(await namesOf(neverListed)).toEqual(['production', 'uat']);
    expect(await namesOf(published)).toEqual(['production', 'qa', 'uat']);
    expect(await namesOf(marked)).toEqual(['production']);
  });

  it('seeds an org an earlier version created after it ran, on the next run', async () => {
    const later = randomUUID();
    await org(later);
    await db.query(M042);
    expect(await namesOf(later)).toEqual(['production', 'staging', 'uat']);
    expect(await unseeded()).toBe(0);
  });
});
