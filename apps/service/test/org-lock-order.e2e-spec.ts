import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { SDK_ACTIONS_FETCH } from '../src/providers/sdk-actions.provider';
import { gmailFake } from './support/gmail-fake';
import { listenOnLoopback } from './support/listen';
import { lockProbes, pause, type Hold } from './support/lock-probes';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface Team {
  org: string;
  env: string;
  invite: string;
  token: string;
  cluster?: string;
}

interface Writer {
  name: string;
  send: (team: Team) => request.Test;
  status: number;
  /** The event the write records under the org, counted to tell whether it landed. */
  event?: string;
  /** Rows the write needs beyond a team's. */
  prepare?: (team: Team) => Promise<void>;
  /** Where the lands-first test holds the write: just before its event or just after its org lock; null when the org delete's own work before its transaction races it. */
  heldAt: 'event' | 'org lock' | null;
  /** What the write answers once the org is gone, when not "Organization not found". */
  gone?: string;
}

const ORG_LOCK = /FROM organizations WHERE id = \$1 FOR KEY SHARE/;

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function webhookDoc(name: string): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When it happens',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['fired: ', '{{trigger.title}}'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [{ source: 'trigger', target: 'announce', source_output: 'main', target_input: 'main' }],
  };
}

describe('every write under an org takes the org row first (e2e, isolated DB, stubbed Composio)', () => {
  let app: INestApplication;
  let db: Client;
  let composio: Server;
  let gmail = '';

  const owner = randomUUID();
  const member = randomUUID();
  const joiner = randomUUID();
  const ownerKey = 'ork_e2e_owner_lock_aaaaaaaaaaaaaaaaaaaaa';
  const memberKey = 'ork_e2e_member_lock_bbbbbbbbbbbbbbbbbbbb';
  const joinerKey = 'ork_e2e_joiner_lock_cccccccccccccccccccc';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const as =
    (key: string) =>
    (r: request.Test, org?: string): request.Test =>
      org
        ? r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', org)
        : r.set('Authorization', `Bearer ${key}`);
  const asOwner = as(ownerKey);
  const asMember = as(memberKey);
  const asJoiner = as(joinerKey);
  const suffix = (): string => randomUUID().slice(0, 8);

  const { gateEmits, holdQuery, lockWaiters, deadlocks, deadlocksSince } = lockProbes(
    () => app,
    () => db,
  );

  const statusOf = (r: request.Test): Promise<number> => r.then((res) => res.status);
  const answer = (r: request.Test): Promise<{ status: number; detail: unknown }> =>
    r.then((res) => ({ status: res.status, detail: res.body.detail }));
  const deleteOrg = (org: string): request.Test => asOwner(http().delete(`/api/orgs/${org}`));

  // An org with a second member, a custom environment and a pending invite: one row of each kind its delete cascades into.
  const team = async (name: string): Promise<Team> => {
    const created = await asOwner(http().post('/api/orgs')).send({ name }).expect(201);
    const org = created.body.id as string;
    const joining = await asOwner(http().post(`/api/orgs/${org}/invites`))
      .send({ email: 'member-lock@e2e.local' })
      .expect(201);
    await asMember(http().post(`/api/orgs/invites/${joining.body.token as string}/accept`)).expect(200);
    const env = await asOwner(http().post('/api/environments'), org)
      .send({ name: `env-${suffix()}` })
      .expect(201);
    const pending = await asOwner(http().post(`/api/orgs/${org}/invites`))
      .send({ email: `pending-${suffix()}@e2e.local` })
      .expect(201);
    return {
      org,
      env: env.body.id as string,
      invite: pending.body.id as string,
      token: pending.body.token as string,
    };
  };

  const fillSlot = (t: Team): request.Test =>
    asOwner(http().put(`/api/environments/${t.env}/slots/gmail`), t.org).send({ connection_id: gmail });
  const setOrgKey = (t: Team, name: string): request.Test =>
    asOwner(http().put(`/api/platform-keys/${name}`), t.org).send({ value: `${name}-${suffix()}` });
  const connectCluster = (t: Team): request.Test =>
    asOwner(http().post(`/api/orgs/${t.org}/clusters/production/connect`)).send({ app: 'slack' });

  const outcome = async (org: string, event: string): Promise<{ org: boolean; events: number }> =>
    (
      await db.query<{ org: boolean; events: number }>(
        `SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1) AS org,
                (SELECT count(*)::int FROM domain_events WHERE type = $2) AS events`,
        [org, event],
      )
    ).rows[0]!;

  const WRITERS: Writer[] = [
    {
      name: 'an environment delete',
      event: 'environment.deleted',
      send: (t) => asOwner(http().delete(`/api/environments/${t.env}`), t.org),
      status: 200,
      heldAt: 'event',
    },
    {
      name: 'an environment rename',
      event: 'environment.renamed',
      send: (t) =>
        asOwner(http().patch(`/api/environments/${t.env}`), t.org).send({ name: `renamed-${suffix()}` }),
      status: 200,
      heldAt: 'event',
    },
    {
      name: 'a member leaving',
      event: 'org.member_left',
      send: (t) => asMember(http().delete(`/api/orgs/${t.org}/members/${member}`)),
      status: 200,
      heldAt: 'event',
    },
    {
      name: 'a role change',
      event: 'org.member_role_changed',
      send: (t) => asOwner(http().patch(`/api/orgs/${t.org}/members/${member}`)).send({ role: 'admin' }),
      status: 200,
      heldAt: 'event',
    },
    {
      name: 'an ownership transfer',
      event: 'org.ownership_transferred',
      send: (t) => asOwner(http().post(`/api/orgs/${t.org}/transfer-ownership`)).send({ user_id: member }),
      status: 201,
      heldAt: 'event',
    },
    {
      name: 'an invite revoke',
      event: 'org.invite_revoked',
      send: (t) => asOwner(http().delete(`/api/orgs/${t.org}/invites/${t.invite}`)),
      status: 200,
      heldAt: 'event',
    },
    {
      name: 'an org rename',
      event: 'org.renamed',
      send: (t) => asOwner(http().patch(`/api/orgs/${t.org}`)).send({ name: `Renamed ${suffix()}` }),
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'an invite',
      event: 'org.member_invited',
      send: (t) =>
        asOwner(http().post(`/api/orgs/${t.org}/invites`)).send({ email: `new-${suffix()}@e2e.local` }),
      status: 201,
      heldAt: 'org lock',
    },
    {
      name: 'an invite accept',
      event: 'org.member_joined',
      send: (t) => asJoiner(http().post(`/api/orgs/invites/${t.token}/accept`)),
      status: 200,
      heldAt: 'org lock',
      gone: 'Invite not found or expired',
    },
    {
      name: 'an environment create',
      event: 'environment.created',
      send: (t) => asOwner(http().post('/api/environments'), t.org).send({ name: `env-${suffix()}` }),
      status: 201,
      heldAt: 'org lock',
    },
    {
      name: "an environment list that creates the org's default environments",
      send: (t) => asOwner(http().get('/api/environments'), t.org),
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'a slot assign',
      send: fillSlot,
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'a slot empty',
      prepare: async (t) => {
        await fillSlot(t).expect(200);
      },
      send: (t) => asOwner(http().delete(`/api/environments/${t.env}/slots/gmail`), t.org),
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'an org platform key set',
      send: (t) => setOrgKey(t, 'anthropic_api_key'),
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'an org platform key clear',
      prepare: async (t) => {
        await setOrgKey(t, 'anthropic_api_key').expect(200);
      },
      send: (t) => asOwner(http().delete('/api/platform-keys/anthropic_api_key'), t.org),
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'a cluster connect',
      prepare: async (t) => {
        await setOrgKey(t, 'composio_api_key').expect(200);
      },
      send: connectCluster,
      status: 201,
      heldAt: null,
    },
    {
      name: 'a cluster connection delete',
      prepare: async (t) => {
        await setOrgKey(t, 'composio_api_key').expect(200);
        t.cluster = (await connectCluster(t).expect(201)).body.connection_id as string;
      },
      send: (t) => asOwner(http().delete(`/api/orgs/${t.org}/clusters/connections/${t.cluster ?? ''}`)),
      status: 200,
      heldAt: null,
    },
    {
      name: 'a workflow deploy',
      event: 'workflow.created',
      send: (t) => asOwner(http().post('/api/deploy'), t.org).send({ workflow_json: webhookDoc('Deployed') }),
      status: 201,
      heldAt: null,
    },
    {
      name: "a member's workflow draft",
      event: 'workflow.created',
      send: (t) => asMember(http().post('/api/deploy'), t.org).send({ workflow_json: webhookDoc('Drafted') }),
      status: 201,
      heldAt: null,
    },
  ];

  // Fails within seconds when the write never reaches its hold, so the test's finally restores the spy.
  const bounded = (hold: Hold, what: string): Hold => {
    const arrived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} never reached its hold`)), 5_000);
      void hold.arrived.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { ...hold, arrived };
  };

  const holdWriter = (writer: Writer): Hold => {
    const gate = writer.heldAt === 'event' && writer.event ? gateEmits(writer.event) : null;
    return bounded(
      gate
        ? { arrived: gate.arrived(0), release: () => gate.release(0), restore: gate.restore }
        : holdQuery(ORG_LOCK, 'after'),
      writer.name,
    );
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-lock@e2e.local', 'Owner', now(), now()),
              ($2, 'member-lock@e2e.local', 'Member', now(), now()),
              ($3, 'joiner-lock@e2e.local', 'Joiner', now(), now())`,
      [owner, member, joiner],
    );
    const personal = [randomUUID(), randomUUID(), randomUUID()];
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner', true, now(), now()), ($2, 'Member', true, now(), now()),
              ($3, 'Joiner', true, now(), now())`,
      personal,
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $3, $4, 'owner', now()),
              (gen_random_uuid(), $5, $6, 'owner', now())`,
      [personal[0], owner, personal[1], member, personal[2], joiner],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'owner', $2, $3, now()),
              (gen_random_uuid(), $4, 'member', $5, $6, now()),
              (gen_random_uuid(), $7, 'joiner', $8, $9, now())`,
      [
        owner,
        hash(ownerKey),
        ownerKey.slice(0, 12),
        member,
        hash(memberKey),
        memberKey.slice(0, 12),
        joiner,
        hash(joinerKey),
        joinerKey.slice(0, 12),
      ],
    );

    let account = 0;
    composio = createServer((req, res) => {
      const url = req.url ?? '';
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      req.resume();
      req.on('end', () => {
        if (req.method === 'GET' && url.startsWith('/api/v3/toolkits')) {
          json(200, {
            items: [{ slug: 'slack', name: 'Slack', composio_managed_auth_schemes: ['OAUTH2'] }],
            next_cursor: null,
          });
        } else if (req.method === 'GET' && url.startsWith('/api/v3/auth_configs')) {
          json(200, { items: [] });
        } else if (req.method === 'POST' && url === '/api/v3/auth_configs') {
          json(201, { toolkit: { slug: 'slack' }, auth_config: { id: `ac_lock_${suffix()}` } });
        } else if (req.method === 'POST' && url === '/api/v3/connected_accounts/link') {
          json(201, {
            redirect_url: 'https://connect.composio.test/lock',
            connected_account_id: `ca_lock_${++account}`,
          });
        } else if (req.method === 'DELETE' && url.startsWith('/api/v3/connected_accounts/')) {
          json(200, { success: true });
        } else {
          json(404, { error: `unexpected ${req.method ?? ''} ${url}` });
        }
      });
    });
    await new Promise<void>((resolve) => composio.listen(0, '127.0.0.1', resolve));

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composio.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_ACTIONS_FETCH)
      .useValue(gmailFake({ 'owner-gmail': 'owner-lock@e2e.local' }).fetch)
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const connection = await asOwner(http().post('/api/connections'))
      .send({ provider: 'gmail', credential: 'owner-gmail' })
      .expect(201);
    gmail = connection.body.id as string;
  }, 30_000);

  afterAll(async () => {
    await pause(500);
    await app.close();
    await db.end();
    await new Promise((resolve) => composio.close(resolve));
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_BASE_URL;
  });

  for (const writer of WRITERS) {
    const event = writer.event ?? '';
    if (writer.heldAt) {
      it(`${writer.name} holding the org row when an org delete starts lands first, and the org delete then removes the org`, async () => {
        const t = await team(`${writer.name}, then an org delete`);
        await writer.prepare?.(t);
        const landed = (await outcome(t.org, event)).events;
        const held = holdWriter(writer);
        const before = await deadlocks();
        try {
          const writing = statusOf(writer.send(t));
          await held.arrived;
          const deleting = statusOf(deleteOrg(t.org));
          await lockWaiters(1);
          held.release();
          expect(await writing).toBe(writer.status);
          expect(await deleting).toBe(200);
        } finally {
          held.restore();
        }
        expect(await outcome(t.org, event)).toEqual({ org: false, events: writer.event ? landed + 1 : 0 });
        expect(await deadlocksSince(before)).toBe(0);
      });
    }

    it(`${writer.name} started while an org delete is in flight waits for it and answers 404`, async () => {
      const t = await team(`an org delete, then ${writer.name}`);
      await writer.prepare?.(t);
      const landed = (await outcome(t.org, event)).events;
      const held = gateEmits('org.deleted', 'after');
      const before = await deadlocks();
      try {
        const deleting = statusOf(deleteOrg(t.org));
        await held.arrived(0);
        const writing = answer(writer.send(t));
        await lockWaiters(1);
        held.release(0);
        expect(await deleting).toBe(200);
        expect(await writing).toEqual({ status: 404, detail: writer.gone ?? 'Organization not found' });
      } finally {
        held.restore();
      }
      expect(await outcome(t.org, event)).toEqual({ org: false, events: landed });
      expect(await deadlocksSince(before)).toBe(0);
    });
  }

  it('a write holding the org row lets an org rename and another write under the org go ahead', async () => {
    const t = await team('Writes side by side');
    const within = <T>(work: PromiseLike<T>): Promise<T | 'blocked'> =>
      Promise.race([work, pause(3_000).then(() => 'blocked' as const)]);
    const held = bounded(
      holdQuery(/FROM organizations WHERE id = \$1 FOR /, 'after'),
      'an environment create',
    );
    try {
      const creating = statusOf(
        asOwner(http().post('/api/environments'), t.org).send({ name: `env-${suffix()}` }),
      );
      await held.arrived;
      await expect(
        db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE NOWAIT`, [t.org]),
      ).rejects.toMatchObject({ code: '55P03' });
      const renaming = await within(
        statusOf(asOwner(http().patch(`/api/orgs/${t.org}`)).send({ name: `Beside ${suffix()}` })),
      );
      const inviting = await within(
        statusOf(
          asOwner(http().post(`/api/orgs/${t.org}/invites`)).send({ email: `beside-${suffix()}@e2e.local` }),
        ),
      );
      expect({ renaming, inviting }).toEqual({ renaming: 200, inviting: 201 });
      held.release();
      expect(await creating).toBe(201);
    } finally {
      held.restore();
    }
  });

  it('a second org delete started while one is in flight waits for it and answers 404', async () => {
    const t = await team('Two org deletes');
    const held = gateEmits('org.deleted', 'after');
    const before = await deadlocks();
    try {
      const first = statusOf(deleteOrg(t.org));
      await held.arrived(0);
      held.release(1);
      const second = answer(deleteOrg(t.org));
      await lockWaiters(1);
      held.release(0);
      expect(await first).toBe(200);
      expect(await second).toEqual({ status: 404, detail: 'Organization not found' });
    } finally {
      held.restore();
    }
    expect(await outcome(t.org, 'org.deleted')).toMatchObject({ org: false });
    expect(await deadlocksSince(before)).toBe(0);
  });
});
