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

type EnvRow = { id: string; name: string; is_prod: boolean };

/** 042 gives an org an earlier version created each default environment it never had, once; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 042: an org gets its default environments once (scratch DB)', () => {
  let db: Client;
  const neverListed = randomUUID();
  const published = randomUUID();
  const uatOnly = randomUUID();
  const neverStaged = randomUUID();
  const stagingDeleted = randomUUID();
  const stagingRenamed = randomUUID();
  const intact = randomUUID();
  const marked = randomUUID();
  const existing = [neverListed, published, uatOnly, neverStaged, stagingDeleted, stagingRenamed, intact];

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
  const event = (id: string, type: string, payload: Record<string, unknown>) =>
    db.query(
      `INSERT INTO domain_events (id, org_id, type, subject_type, payload, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'environment', $3, now())`,
      [id, type, JSON.stringify(payload)],
    );
  const envsOf = async (id: string): Promise<EnvRow[]> =>
    (
      await db.query<EnvRow>(`SELECT id, name, is_prod FROM environments WHERE org_id = $1 ORDER BY name`, [
        id,
      ])
    ).rows;
  const namesOf = async (id: string): Promise<string[]> => (await envsOf(id)).map((e) => e.name);
  const everyOrgsEnvs = async (): Promise<EnvRow[][]> => {
    const all = [];
    for (const id of [...existing, marked]) all.push(await envsOf(id));
    return all;
  };
  const unseeded = async (): Promise<number> =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM organizations WHERE environments_seeded_at IS NULL`,
      )
    ).rows[0]!.n;
  const keeps = (rows: EnvRow[]) => expect.arrayContaining(rows.map((row) => expect.objectContaining(row)));

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('ALTER TABLE organizations DROP COLUMN environments_seeded_at');
    for (const id of existing) await org(id);
    await envs(published, 'production');
    await envs(uatOnly, 'uat');
    await envs(neverStaged, 'production', 'uat');
    await envs(stagingDeleted, 'production', 'uat');
    await event(stagingDeleted, 'environment.deleted', { name: 'staging', removed_pointers: 0 });
    await envs(stagingRenamed, 'production', 'preview', 'uat');
    await event(stagingRenamed, 'environment.renamed', { from: 'staging', to: 'preview' });
    await envs(intact, 'production', 'staging', 'uat');
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('gives an org each default environment it never had, keeps every row it had, and leaves a staging its events show deleted or renamed missing', async () => {
    const before = {
      published: await envsOf(published),
      uatOnly: await envsOf(uatOnly),
      neverStaged: await envsOf(neverStaged),
      stagingDeleted: await envsOf(stagingDeleted),
      stagingRenamed: await envsOf(stagingRenamed),
      intact: await envsOf(intact),
    };
    await db.query(M042);

    const defaults = [...DEFAULT_ENVS]
      .sort()
      .map((name) => ({ id: expect.any(String), name, is_prod: name === 'production' }));
    expect(await envsOf(neverListed)).toEqual(defaults);
    for (const id of [published, uatOnly, neverStaged]) expect(await envsOf(id)).toEqual(defaults);
    expect(await envsOf(published)).toEqual(keeps(before.published));
    expect(await envsOf(uatOnly)).toEqual(keeps(before.uatOnly));
    expect(await envsOf(neverStaged)).toEqual(keeps(before.neverStaged));
    expect(await envsOf(stagingDeleted)).toEqual(before.stagingDeleted);
    expect(await envsOf(stagingRenamed)).toEqual(before.stagingRenamed);
    expect(await envsOf(intact)).toEqual(before.intact);
    expect(await unseeded()).toBe(0);
  });

  it('a re-run touches no org it has considered, nor one created with its environments, whatever they lost since', async () => {
    await db.query(`DELETE FROM environments WHERE org_id = $1 AND name = 'staging'`, [neverListed]);
    await db.query(`UPDATE environments SET name = 'qa' WHERE org_id = $1 AND name = 'staging'`, [published]);
    await db.query(`DELETE FROM environments WHERE org_id = $1 AND name = 'uat'`, [neverStaged]);
    await org(marked);
    await seedDefaultEnvironments(db, marked);
    await db.query(`DELETE FROM environments WHERE org_id = $1 AND name <> 'production'`, [marked]);
    const settled = await everyOrgsEnvs();

    await db.query(M042);
    await db.query(M042);

    expect(await everyOrgsEnvs()).toEqual(settled);
    expect(await namesOf(neverListed)).toEqual(['production', 'uat']);
    expect(await namesOf(published)).toEqual(['production', 'qa', 'uat']);
    expect(await namesOf(neverStaged)).toEqual(['production', 'staging']);
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
