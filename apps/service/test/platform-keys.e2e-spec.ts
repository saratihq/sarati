import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { INTERNAL_ISSUER, INTERNAL_TOKEN_HEADER } from '../src/platform/internal-token';
import { PLATFORM_KEY_NAMES, PlatformKeysService } from '../src/platform/platform-keys.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/**
 * The two optional platform keys are instance-wide, owner/admin-only, write-only, and the ONLY
 * source for their capabilities — env no longer supplies them. Everything below is over real
 * HTTP against a real boot, because the point of the feature is that it needs no restart.
 */
const SECRET = 'platform-keys-e2e-shared-secret';

describe('platform keys (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const owner = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const orgId = randomUUID();
  const personalOwner = randomUUID();
  const personalAdmin = randomUUID();
  const personalMember = randomUUID();
  const keyOwner = 'ork_platform_owner_key_1234567890';
  const keyAdmin = 'ork_platform_admin_key_1234567890';
  const keyMember = 'ork_platform_member_key_123456789';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const as = (r: request.Test, key: string): request.Test =>
    r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', orgId);
  const http = (): request.Agent => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    // Distinct registration times, as a real install has: the owner bootstrapped the instance,
    // the others joined by invite afterwards.
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'pk-owner@e2e.local', 'Owner', now() - interval '3 days', now()),
              ($2, 'pk-admin@e2e.local', 'Admin', now() - interval '2 days', now()),
              ($3, 'pk-member@e2e.local', 'Member', now() - interval '1 day', now())`,
      [owner, admin, member],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Acme', false, now(), now()),
              ($2, 'Owner', true, now(), now()),
              ($3, 'Admin', true, now(), now()),
              ($4, 'Member', true, now(), now())`,
      [orgId, personalOwner, personalAdmin, personalMember],
    );
    // Everyone OWNS their personal org — the reason an active-org role check grants everyone.
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()),
              (gen_random_uuid(), $1, $3, 'admin', now()),
              (gen_random_uuid(), $1, $4, 'member', now()),
              (gen_random_uuid(), $5, $2, 'owner', now()),
              (gen_random_uuid(), $6, $3, 'owner', now()),
              (gen_random_uuid(), $7, $4, 'owner', now())`,
      [orgId, owner, admin, member, personalOwner, personalAdmin, personalMember],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'o', $2, $3, now()),
              (gen_random_uuid(), $4, 'a', $5, $6, now()),
              (gen_random_uuid(), $7, 'm', $8, $9, now())`,
      [
        owner,
        hash(keyOwner),
        keyOwner.slice(0, 12),
        admin,
        hash(keyAdmin),
        keyAdmin.slice(0, 12),
        member,
        hash(keyMember),
        keyMember.slice(0, 12),
      ],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.SECRET_KEY = SECRET;
    // The whole point: these must be inert. If either still reached a consumer, the
    // "managed connections stay off until a key is stored" test below would fail.
    process.env.COMPOSIO_API_KEY = 'env-key-that-must-be-ignored';
    process.env.ANTHROPIC_API_KEY = 'env-key-that-must-be-ignored';

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
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(async () => {
    const keys = app.get(PlatformKeysService);
    for (const scope of [orgScope, userScope(owner), userScope(admin), userScope(member)]) {
      for (const name of PLATFORM_KEY_NAMES) await keys.clear(scope, name);
    }
  });

  const userScope = (userId: string) => ({ kind: 'user' as const, userId });
  const orgScope = { kind: 'org' as const, orgId };

  /** The agent's shape: the CALLER's bearer decides whose key, the internal token proves the process. */
  const internalRead = (callerKey: string, internal: string): request.Test =>
    request(app.getHttpServer())
      .get('/api/internal/platform-keys/anthropic')
      .set('Authorization', `Bearer ${callerKey}`)
      .set('X-Org-Id', orgId)
      .set(INTERNAL_TOKEN_HEADER, internal);

  async function internalToken(secret = SECRET, issuer = INTERNAL_ISSUER): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(secret));
  }

  describe('the store is the only source', () => {
    it('ignores the environment entirely — managed connections stay off until a key is stored', async () => {
      const before = await as(http().get('/api/connections/capabilities'), keyOwner).expect(200);
      expect(before.body).toEqual({ managed_available: false });

      await as(http().put('/api/platform-keys/composio_api_key'), keyOwner)
        .send({ value: 'ck_stored' })
        .expect(200);

      // No restart, no re-boot of the module: the same running app changes its answer.
      const after = await as(http().get('/api/connections/capabilities'), keyOwner).expect(200);
      expect(after.body).toEqual({ managed_available: true });
    });

    it('goes back off when the key is removed', async () => {
      await as(http().put('/api/platform-keys/composio_api_key'), keyOwner)
        .send({ value: 'ck_stored' })
        .expect(200);
      await as(http().delete('/api/platform-keys/composio_api_key'), keyOwner).expect(200);

      const res = await as(http().get('/api/connections/capabilities'), keyOwner).expect(200);
      expect(res.body).toEqual({ managed_available: false });
    });

    it('stores the value ENCRYPTED, never as plaintext in the row', async () => {
      await as(http().put('/api/platform-keys/anthropic_api_key'), keyOwner)
        .send({ value: 'sk-ant-plaintext-never-at-rest' })
        .expect(200);

      const rows = await db.query(`SELECT secret FROM platform_secrets WHERE name = 'anthropic_api_key'`);
      expect(rows.rows[0].secret).not.toContain('sk-ant-plaintext-never-at-rest');
      await expect(app.get(PlatformKeysService).get(orgScope, 'anthropic_api_key')).resolves.toBe(
        'sk-ant-plaintext-never-at-rest',
      );
    });

    it('a row belongs to a user or an org, never to the instance', async () => {
      await expect(
        db.query(`INSERT INTO platform_secrets (name, secret) VALUES ('composio_api_key', 'x')`),
      ).rejects.toThrow(/platform_secrets_one_owner/);
    });
  });

  describe('write-only over the API', () => {
    it('reports presence and never the value', async () => {
      await as(http().put('/api/platform-keys/composio_api_key'), keyOwner)
        .send({ value: 'ck_super_secret_value' })
        .expect(200);

      const res = await as(http().get('/api/platform-keys'), keyOwner).expect(200);

      expect(res.body.keys.composio_api_key).toMatchObject({ present: true });
      expect(res.body.keys.anthropic_api_key).toMatchObject({ present: false, updated_at: null });
      expect(JSON.stringify(res.body)).not.toContain('ck_super_secret_value');
    });

    it('a PUT answers presence only, never an echo of what was sent', async () => {
      const res = await as(http().put('/api/platform-keys/anthropic_api_key'), keyOwner)
        .send({ value: 'sk-ant-echo-check' })
        .expect(200);

      expect(res.body).toEqual({ secret_present: true });
    });

    it('refuses a blank value rather than storing an empty key', async () => {
      await as(http().put('/api/platform-keys/composio_api_key'), keyOwner)
        .send({ value: '   ' })
        .expect(400);
      await as(http().put('/api/platform-keys/composio_api_key'), keyOwner).send({ value: '' }).expect(400);
    });

    it('is not a general secrets manager — an unknown name is a 404', async () => {
      await as(http().put('/api/platform-keys/openai_api_key'), keyOwner).send({ value: 'x' }).expect(404);
      await as(http().delete('/api/platform-keys/database_url'), keyOwner).expect(404);
    });
  });

  describe('who may write', () => {
    it('an org owner and an org admin may write the ORG key', async () => {
      await as(http().put('/api/platform-keys/composio_api_key'), keyOwner).send({ value: 'a' }).expect(200);
      await as(http().put('/api/platform-keys/composio_api_key'), keyAdmin).send({ value: 'b' }).expect(200);
    });

    it('a plain member of that org may not, and is told who can', async () => {
      const res = await as(http().put('/api/platform-keys/composio_api_key'), keyMember)
        .send({ value: 'nope' })
        .expect(403);
      expect(res.body.detail ?? res.body.message).toMatch(/owner or admin of this organization/i);

      await as(http().delete('/api/platform-keys/composio_api_key'), keyMember).expect(403);
    });

    it('the role is checked against THAT org, not any org the caller happens to own', async () => {
      // The member owns their own organization; that confers nothing over Acme's keys.
      const created = await request(app.getHttpServer())
        .post('/api/orgs')
        .set('Authorization', `Bearer ${keyMember}`)
        .send({ name: 'Member Corp' })
        .expect(201);
      const ownOrgId = created.body.id as string;
      const role = await db.query(`SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`, [
        ownOrgId,
        member,
      ]);
      expect(role.rows[0].role).toBe('owner');

      await as(http().put('/api/platform-keys/composio_api_key'), keyMember)
        .send({ value: 'nope' })
        .expect(403);

      // In their OWN org they are the owner, so there they may.
      await request(app.getHttpServer())
        .put('/api/platform-keys/composio_api_key')
        .set('Authorization', `Bearer ${keyMember}`)
        .set('X-Org-Id', ownOrgId)
        .send({ value: 'their-own-orgs-key' })
        .expect(200);
    });

    it('anyone may write their OWN key, in their personal context', async () => {
      await request(app.getHttpServer())
        .put('/api/platform-keys/anthropic_api_key')
        .set('Authorization', `Bearer ${keyMember}`)
        .set('X-Org-Id', personalMember)
        .send({ value: 'sk-ant-mine' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/platform-keys')
        .set('Authorization', `Bearer ${keyMember}`)
        .set('X-Org-Id', personalMember)
        .expect(200);
      expect(res.body).toMatchObject({ scope: 'user', can_manage: true });
    });

    it('reports whose keys are on screen, so the UI can say so', async () => {
      const inOrg = await as(http().get('/api/platform-keys'), keyOwner).expect(200);
      expect(inOrg.body).toMatchObject({ scope: 'org', can_manage: true });
    });

    it('refuses an unauthenticated caller outright', async () => {
      await http().get('/api/platform-keys').expect(401);
      await http().put('/api/platform-keys/composio_api_key').send({ value: 'x' }).expect(401);
    });
  });

  describe('the internal read agent-service uses', () => {
    it('hands the key to a process holding the shared secret', async () => {
      await as(http().put('/api/platform-keys/anthropic_api_key'), keyOwner)
        .send({ value: 'sk-ant-for-the-agent' })
        .expect(200);

      const res = await internalRead(keyOwner, await internalToken()).expect(200);

      expect(res.body).toEqual({ api_key: 'sk-ant-for-the-agent' });
    });

    it('answers null rather than 404 when nothing is stored', async () => {
      const res = await internalRead(keyOwner, await internalToken()).expect(200);

      expect(res.body).toEqual({ api_key: null });
    });

    it('refuses a token signed with a different secret', async () => {
      await internalRead(keyOwner, await internalToken('not-the-shared-secret')).expect(401);
    });

    it('refuses a foreign issuer even when it is signed with the right secret', async () => {
      // A user session is signed with the same key: holding one must not read platform secrets.
      await internalRead(keyOwner, await internalToken(SECRET, 'orchestr:local')).expect(401);
    });

    it('refuses the raw secret as a bearer, and an absent one', async () => {
      await internalRead(keyOwner, SECRET).expect(401);
      await internalRead(keyOwner, '').expect(401);
    });

    it('is not reachable with a normal user credential', async () => {
      // A user credential alone — no process credential — reads nothing back out.
      await as(http().get('/api/internal/platform-keys/anthropic'), keyOwner).expect(401);
      // ...and the process credential alone, with no caller, is not authenticated either.
      await http()
        .get('/api/internal/platform-keys/anthropic')
        .set(INTERNAL_TOKEN_HEADER, await internalToken())
        .expect(401);
    });
  });

  it('the managed rail reads the key per call, so a change lands without a new provider', async () => {
    const connections = app.get(ConnectionsService);
    await expect(connections.managedConfigured(orgScope)).resolves.toBe(false);

    await app.get(PlatformKeysService).set(orgScope, 'composio_api_key', 'ck_live');
    await expect(connections.managedConfigured(orgScope)).resolves.toBe(true);
  });

  describe('scopes are isolated', () => {
    it("one user's key is invisible and unwritable to another", async () => {
      // The member writes their OWN key, in their own personal context.
      await request(app.getHttpServer())
        .put('/api/platform-keys/composio_api_key')
        .set('Authorization', `Bearer ${keyMember}`)
        .set('X-Org-Id', personalMember)
        .send({ value: 'members-own-key' })
        .expect(200);

      // The admin, in THEIR personal context, sees nothing of it.
      const other = await request(app.getHttpServer())
        .get('/api/platform-keys')
        .set('Authorization', `Bearer ${keyAdmin}`)
        .set('X-Org-Id', personalAdmin)
        .expect(200);
      expect(other.body.keys.composio_api_key.present).toBe(false);
      expect(JSON.stringify(other.body)).not.toContain('members-own-key');

      // And the stored values really are separate rows, not one shared key.
      await expect(app.get(PlatformKeysService).get(userScope(member), 'composio_api_key')).resolves.toBe(
        'members-own-key',
      );
      await expect(
        app.get(PlatformKeysService).get(userScope(admin), 'composio_api_key'),
      ).resolves.toBeNull();
    });

    it('a member of an org uses the org key without setting anything of their own', async () => {
      await as(http().put('/api/platform-keys/composio_api_key'), keyAdmin)
        .send({ value: 'org-shared-key' })
        .expect(200);

      const seen = await as(http().get('/api/platform-keys'), keyMember).expect(200);
      expect(seen.body).toMatchObject({ scope: 'org', can_manage: false });
      expect(seen.body.keys.composio_api_key.present).toBe(true);

      // The rail is on for them, in the org context, with no personal key stored.
      const caps = await as(http().get('/api/connections/capabilities'), keyMember).expect(200);
      expect(caps.body).toEqual({ managed_available: true });
      await expect(
        app.get(PlatformKeysService).get(userScope(member), 'composio_api_key'),
      ).resolves.toBeNull();
    });

    it('a user outside any org uses their own', async () => {
      const personal = (r: request.Test): request.Test =>
        r.set('Authorization', `Bearer ${keyMember}`).set('X-Org-Id', personalMember);

      await personal(http().get('/api/connections/capabilities')).expect(200, {
        managed_available: false,
      });
      await personal(http().put('/api/platform-keys/composio_api_key')).send({ value: 'mine' }).expect(200);
      await personal(http().get('/api/connections/capabilities')).expect(200, {
        managed_available: true,
      });
    });
  });
});
