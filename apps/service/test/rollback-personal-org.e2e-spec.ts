import { lastReleaseWithout } from './support/earlier-build';
import { MOCK_USER_ID, rollbackSuite } from './support/rollback';

const BEFORE_044 = lastReleaseWithout('apps/service/db/migrations/044_personal_org_single_member.sql');
const PASSWORD = 'a-password-long-enough';
const PASSWORD_SIGN_IN = {
  MOCK_AUTH: 'false',
  LOCAL_AUTH_ENABLED: 'true',
  SECRET_KEY: 'an-e2e-secret-key-for-accounts-across-a-rollback',
};

/** The last release before 044, making accounts on a database this build upgraded, and this build booted back over them (child processes, password sign-in). */
describe(`an account ${BEFORE_044.tag} makes after this version’s upgrade, and coming back (e2e)`, () => {
  const rollback = rollbackSuite(BEFORE_044.sha, () => undefined);
  let base = '';

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const signUp = (email: string, inviteToken: string) =>
    call('POST', '/api/auth/local/register', { email, password: PASSWORD, invite_token: inviteToken });
  const invite = async (orgId: string, email: string, token?: string): Promise<string> => {
    const res = await call('POST', `/api/orgs/${orgId}/invites`, { email, role: 'member' }, token);
    expect(res.status).toBe(201);
    return res.body.token as string;
  };
  const accounts = async (): Promise<unknown[]> =>
    (
      await rollback.db().query(
        `SELECT u.email, o.id AS personal, o.is_personal, o.personal_owner_id = u.id AS owns,
                array(SELECT m.org_id || ':' || m.role || ':' || m.is_personal FROM org_members m
                       WHERE m.user_id = u.id ORDER BY m.org_id) AS memberships,
                array(SELECT m.user_id::text FROM org_members m WHERE m.org_id = o.id) AS members
           FROM users u LEFT JOIN organizations o ON o.personal_owner_id = u.id
          WHERE u.id <> $1 ORDER BY u.email`,
        [MOCK_USER_ID],
      )
    ).rows;

  it('signs one up there with an invite, owning a personal workspace no invite there joins, and coming back keeps every account as it is, dropping only that invite', async () => {
    let service = await rollback.boot('this');
    base = service.base;
    const team = await call('POST', '/api/orgs', { name: 'Team' });
    expect(team.status).toBe(201);
    const teamId = team.body.id as string;
    const toBo = await invite(teamId, 'bo@x.test');
    await service.crash();

    expect(await rollback.migrate('earlier')).toContain('schema is up to date');
    service = await rollback.boot('earlier', PASSWORD_SIGN_IN);
    base = service.base;
    const bo = await signUp('bo@x.test', toBo);
    expect(bo.status).toBe(201);
    const boId = (bo.body.user as { id: string }).id;
    const [made] = (await accounts()) as Array<{ personal: string }>;
    expect([made]).toEqual([
      {
        email: 'bo@x.test',
        personal: expect.any(String),
        is_personal: true,
        owns: true,
        memberships: [`${made!.personal}:owner:true`, `${teamId}:member:false`].sort(),
        members: [boId],
      },
    ]);

    const toCy = await invite(made!.personal, 'cy@x.test', bo.body.token as string);
    const cy = await signUp('cy@x.test', toCy);
    expect(cy.status).toBe(500);
    const cySignedIn = await call('POST', '/api/auth/local/login', {
      email: 'cy@x.test',
      password: PASSWORD,
    });
    expect(cySignedIn.status).toBe(200);
    const accepted = await call(
      'POST',
      `/api/orgs/invites/${toCy}/accept`,
      undefined,
      cySignedIn.body.token as string,
    );
    expect(accepted.status).toBe(500);
    const there = (await accounts()) as Array<{ email: string; personal: string; memberships: string[] }>;
    expect(there).toEqual([
      expect.objectContaining({ email: 'bo@x.test', members: [boId] }),
      expect.objectContaining({ email: 'cy@x.test', is_personal: true, owns: true }),
    ]);
    expect(there[1]!.memberships).toEqual([`${there[1]!.personal}:owner:true`]);
    await service.crash();

    const migrated = await rollback.migrate('this');
    expect(migrated).toContain('schema is up to date');
    expect(migrated.split('\n').filter((line) => line.startsWith('044 '))).toEqual([
      `044 deleted the pending invite of cy@x.test as member into personal workspace ${made!.personal}`,
    ]);
    expect(await accounts()).toEqual(there);

    service = await rollback.boot('this', PASSWORD_SIGN_IN);
    base = service.base;
    const signedIn = await call('POST', '/api/auth/local/login', { email: 'bo@x.test', password: PASSWORD });
    expect(signedIn.status).toBe(200);
    const orgs = await call('GET', '/api/orgs', undefined, signedIn.body.token as string);
    expect(orgs.body.orgs).toEqual([
      { id: made!.personal, name: 'bo', is_personal: true, role: 'owner' },
      { id: teamId, name: 'Team', is_personal: false, role: 'member' },
    ]);
  }, 300_000);
});
