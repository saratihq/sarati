import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M027 = readFileSync(join(__dirname, '..', 'db', 'migrations', '027_review_test_results.sql'), 'utf8');

/**
 * 027 carries each review's stored test into review_test_results, and `db:migrate` re-runs it on every boot:
 * a re-run must copy only what is new, never twice. Scratch DB only — NEVER a live one.
 */
describe('migration 027: carrying stored review tests over (scratch DB)', () => {
  let db: Client;
  const user = randomUUID();
  const wf = randomUUID();
  const lane = randomUUID();
  const main = randomUUID();
  const [vSource, vTarget] = [randomUUID(), randomUUID()];
  const reviews = {
    red: randomUUID(),
    bothFailed: randomUUID(),
    noVersions: randomUUID(),
    another: randomUUID(),
  };

  const test = (verdict: 'red' | 'green', testedAt: string, head = 'completed', versions = true) =>
    JSON.stringify({
      verdict,
      tested_at: testedAt,
      source_version_id: versions ? vSource : null,
      target_version_id: versions ? vTarget : null,
      base: { status: head === 'error' && verdict === 'green' ? 'error' : 'completed' },
      head: { status: verdict === 'red' ? 'error' : head },
    });

  const rows = async () =>
    (
      await db.query<{ review_id: string; verdict: string; decisive: boolean; tested_at: Date }>(
        `SELECT review_id, verdict, decisive, tested_at FROM review_test_results ORDER BY tested_at, review_id`,
      )
    ).rows;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('DROP TABLE review_test_results');
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'mig@e2e.local', 'Mig', now(), now())`,
      [user],
    );
    await db.query(
      `INSERT INTO workflows (id, name, created_at, updated_at) VALUES ($1, 'wf', now(), now())`,
      [wf],
    );
    await db.query(
      `INSERT INTO workflow_branches (id, workflow_id, name) VALUES ($1, $3, 'lane'), ($2, $3, 'main')`,
      [lane, main, wf],
    );
    const review = (id: string, lastTest: string) =>
      db.query(
        `INSERT INTO workflow_reviews (id, workflow_id, source_branch_id, target_branch_id, title, author_id, last_test)
         VALUES ($1, $2, $3, $4, 'r', $5, $6::json)`,
        [id, wf, lane, main, user, lastTest],
      );
    await review(reviews.red, test('red', '2026-10-08T10:00:00.000Z'));
    await review(reviews.bothFailed, test('green', '2026-10-08T11:00:00.000Z', 'error'));
    await review(reviews.noVersions, test('red', '2026-10-08T12:00:00.000Z', 'error', false));
    await review(reviews.another, test('red', '2026-10-08T13:00:00.000Z'));
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('copies each stored test once, with its verdict and whether it can decide a merge', async () => {
    await db.query(M027);
    await db.query(M027);
    expect(await rows()).toEqual([
      {
        review_id: reviews.red,
        verdict: 'red',
        decisive: true,
        tested_at: new Date('2026-10-08T10:00:00.000Z'),
      },
      {
        review_id: reviews.bothFailed,
        verdict: 'green',
        decisive: false,
        tested_at: new Date('2026-10-08T11:00:00.000Z'),
      },
      {
        review_id: reviews.another,
        verdict: 'red',
        decisive: true,
        tested_at: new Date('2026-10-08T13:00:00.000Z'),
      },
    ]);
  });

  it('on a later boot copies only a stored test that is newer than what it already holds', async () => {
    await db.query(`UPDATE workflow_reviews SET last_test = $2::json WHERE id = $1`, [
      reviews.red,
      test('green', '2026-10-08T14:00:00.000Z'),
    ]);
    await db.query(M027);
    const red = (await rows()).filter((r) => r.review_id === reviews.red);
    expect(red.map((r) => [r.verdict, r.tested_at.toISOString()])).toEqual([
      ['red', '2026-10-08T10:00:00.000Z'],
      ['green', '2026-10-08T14:00:00.000Z'],
    ]);
  });
});
