import { randomUUID } from 'node:crypto';

import { hashPassword } from '../src/auth/local/password';
import { keyHash } from './support/api-keys';
import { lastReleaseWithout } from './support/earlier-build';
import { insertPersonalOrgs } from './support/personal-org';
import { rollbackSuite } from './support/rollback';

const BEFORE_046 = lastReleaseWithout('apps/service/db/migrations/046_api_keys_pinned.sql');
const PASSWORD = 'a-password-long-enough';
const PASSWORD_SIGN_IN = {
  MOCK_AUTH: 'false',
  LOCAL_AUTH_ENABLED: 'true',
  SECRET_KEY: 'an-e2e-secret-key-for-api-keys-across-a-rollback',
};
const LEGACY_KEY = 'ork_e2e_rb_legacy_key_aaaaaaaaaaaaaaaaaaaa';

/** The last release before 046 on a database this version upgraded, making keys there, and this version booted back over them (child processes, password sign-in). */
describe(`an API key across a rollback to ${BEFORE_046.tag} and back (e2e)`, () => {
  const rollback = rollbackSuite(BEFORE_046.sha, () => undefined);
  const ada = randomUUID();
  const adaHome = randomUUID();
  const team = randomUUID();
  let base = '';

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; bearer?: string; org?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.org ? { 'x-org-id': opts.org } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const reach = async (bearer: string): Promise<Record<string, number>> => ({
    home: (await call('GET', '/api/workflows', { bearer })).status,
    team: (await call('GET', '/api/workflows', { bearer, org: team })).status,
  });
  const keys = async (): Promise<Array<{ name: string; org_id: string | null; owns: boolean | null }>> =>
    (
      await rollback.db().query<{ name: string; org_id: string | null; owns: boolean | null }>(
        `SELECT k.name, k.org_id, o.personal_owner_id = k.user_id AS owns
           FROM api_keys k LEFT JOIN organizations o ON o.id = k.org_id ORDER BY k.name`,
      )
    ).rows;
  const orgIdNullable = async (): Promise<string> =>
    (
      await rollback
        .db()
        .query<{ is_nullable: string }>(
          `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'api_keys' AND column_name = 'org_id'`,
        )
    ).rows[0]!.is_nullable;

  it('pins a key the upgrade finds unpinned, keeps every key there pinned to its holder’s own workspace — a new account’s too — and coming back changes no key', async () => {
    const db = rollback.db();
    await db.query(`ALTER TABLE api_keys ALTER COLUMN org_id DROP NOT NULL`);
    await db.query(
      `INSERT INTO users (id, email, name, hashed_password, created_at, updated_at) VALUES ($1, 'ada@x.test', 'ada', $2, now(), now())`,
      [ada, await hashPassword(PASSWORD)],
    );
    await insertPersonalOrgs(db, { id: adaHome, userId: ada, name: 'ada' });
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at, environments_seeded_at) VALUES ($1, 'Team', false, now(), now(), now())`,
      [team],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [team, ada],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, NULL, 'legacy', $2, $3, '["workflow:read"]', now())`,
      [ada, keyHash(LEGACY_KEY), LEGACY_KEY.slice(0, 12)],
    );

    const upgraded = await rollback.migrate('this');
    expect(upgraded.split('\n').filter((line) => line.startsWith('046 '))).toEqual([
      expect.stringMatching(/^046 pinned API key legacy \(.+\) of ada@x\.test to their personal workspace /),
    ]);
    expect(await orgIdNullable()).toBe('NO');
    let service = await rollback.boot('this', PASSWORD_SIGN_IN);
    base = service.base;
    expect(await reach(LEGACY_KEY)).toEqual({ home: 200, team: 403 });
    await service.crash();

    expect(await rollback.migrate('earlier')).toContain('schema is up to date');
    expect(await orgIdNullable()).toBe('NO');
    service = await rollback.boot('earlier', PASSWORD_SIGN_IN);
    base = service.base;
    const adaSession = (
      await call('POST', '/api/auth/local/login', { body: { email: 'ada@x.test', password: PASSWORD } })
    ).body.token as string;
    const adaThere = await call('POST', '/api/api-keys', {
      bearer: adaSession,
      body: { name: 'made there', scopes: ['workflow:read', 'org:manage'] },
    });
    expect(adaThere.status).toBe(201);
    const invite = await call('POST', `/api/orgs/${team}/invites`, {
      bearer: adaSession,
      body: { email: 'bo@x.test', role: 'member' },
    });
    expect(invite.status).toBe(201);
    const bo = await call('POST', '/api/auth/local/register', {
      body: { email: 'bo@x.test', password: PASSWORD, invite_token: invite.body.token },
    });
    expect(bo.status).toBe(201);
    const boThere = await call('POST', '/api/api-keys', {
      bearer: bo.body.token as string,
      body: { name: 'new account there', scopes: ['workflow:read'] },
    });
    expect(boThere.status).toBe(201);
    const made = [adaThere.body.key as string, boThere.body.key as string];
    for (const bearer of [LEGACY_KEY, ...made]) expect(await reach(bearer)).toEqual({ home: 200, team: 403 });
    const listedThere = (await call('GET', '/api/orgs', { bearer: LEGACY_KEY })).body.orgs as unknown[];
    expect(listedThere).toHaveLength(2);
    expect(
      (await call('POST', '/api/orgs', { bearer: made[0], body: { name: 'Made by a key there' } })).status,
    ).toBe(201);
    const there = await keys();
    expect(there).toEqual([
      { name: 'legacy', org_id: adaHome, owns: true },
      { name: 'made there', org_id: adaHome, owns: true },
      { name: 'new account there', org_id: expect.any(String), owns: true },
    ]);
    await service.crash();

    const back = await rollback.migrate('this');
    expect(back).toContain('schema is up to date');
    expect(back.split('\n').filter((line) => /^04[46] /.test(line))).toEqual([]);
    expect(await keys()).toEqual(there);
    service = await rollback.boot('this', PASSWORD_SIGN_IN);
    base = service.base;
    for (const bearer of [LEGACY_KEY, ...made]) {
      expect(await reach(bearer)).toEqual({ home: 200, team: 403 });
      const listed = (await call('GET', '/api/orgs', { bearer })).body.orgs as Array<{
        is_personal: boolean;
      }>;
      expect(listed.map((o) => o.is_personal)).toEqual([true]);
    }
    expect(
      (await call('POST', '/api/orgs', { bearer: made[0], body: { name: 'Made by a key here' } })).status,
    ).toBe(403);
  }, 300_000);
});
