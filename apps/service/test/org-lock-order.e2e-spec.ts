import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { fernetDecrypt, fernetEncrypt } from '../src/common/crypto/fernet';
import { EventsService, type DomainEventInput } from '../src/events/events.service';
import { SDK_ACTIONS_FETCH } from '../src/providers/sdk-actions.provider';
import { gmailFake } from './support/gmail-fake';
import { listenOnLoopback } from './support/listen';
import { bounded, lockProbes, pause, type Hold } from './support/lock-probes';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface Team {
  org: string;
  env: string;
  envName: string;
  invite: string;
  inviteEmail: string;
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
  /** Where the lands-first test holds the write: just before its event or just after its org lock. */
  heldAt: 'event' | 'org lock';
  /** What an org delete answers with 409 once the write has landed, when the org delete removes the org otherwise. */
  refusal?: string;
  /** What the write answers once the org is gone, when not 404 "Organization not found". */
  gone?: { status: number; detail: string };
}

const ORG_LOCK = /FROM organizations WHERE id = \$1 FOR KEY SHARE/;
const ORG_GONE = { status: 404, detail: 'Organization not found' };
const SIGNUP_CLOSED = {
  status: 403,
  detail: 'This instance is not open for signup — ask an owner for an invite link.',
};
const HAS_WORKFLOW =
  'This organization still has 1 workflow — move or delete them before deleting the organization.';

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
  let dbUrl = '';
  let composio: Server;
  let gmail = '';
  const composioAccounts = {
    created: new Set<string>(),
    deleted: new Set<string>(),
    deletedWhileHeld: new Set<string>(),
  };

  const owner = randomUUID();
  const member = randomUUID();
  const joiner = randomUUID();
  const rival = randomUUID();
  const ownerKey = 'ork_e2e_owner_lock_aaaaaaaaaaaaaaaaaaaaa';
  const memberKey = 'ork_e2e_member_lock_bbbbbbbbbbbbbbbbbbbb';
  const joinerKey = 'ork_e2e_joiner_lock_cccccccccccccccccccc';
  const rivalKey = 'ork_e2e_rival_lock_dddddddddddddddddddddd';
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
  const asRival = as(rivalKey);
  const suffix = (): string => randomUUID().slice(0, 8);

  const { gateEmits, holdQuery, lockWaiters, deadlocks, deadlocksSince } = lockProbes(
    () => app,
    () => db,
  );

  const statusOf = (r: request.Test): Promise<number> => r.then((res) => res.status);
  const answer = (r: request.Test): Promise<{ status: number; detail: unknown }> =>
    r.then((res) => ({ status: res.status, detail: res.body.detail }));
  const within = <T>(work: PromiseLike<T>): Promise<T | 'blocked'> =>
    Promise.race([work, pause(3_000).then(() => 'blocked' as const)]);
  const deleteOrg = (org: string): request.Test => asOwner(http().delete(`/api/orgs/${org}`));

  // An org with a second member, a custom environment and a pending invite: one row of each kind its delete cascades into.
  const team = async (name: string): Promise<Team> => {
    const created = await asOwner(http().post('/api/orgs')).send({ name }).expect(201);
    const org = created.body.id as string;
    const joining = await asOwner(http().post(`/api/orgs/${org}/invites`))
      .send({ email: 'member-lock@e2e.local' })
      .expect(201);
    await asMember(http().post(`/api/orgs/invites/${joining.body.token as string}/accept`)).expect(200);
    const envName = `env-${suffix()}`;
    const env = await asOwner(http().post('/api/environments'), org).send({ name: envName }).expect(201);
    const inviteEmail = `pending-${suffix()}@e2e.local`;
    const pending = await asOwner(http().post(`/api/orgs/${org}/invites`))
      .send({ email: inviteEmail })
      .expect(201);
    return {
      org,
      env: env.body.id as string,
      envName,
      invite: pending.body.id as string,
      inviteEmail,
      token: pending.body.token as string,
    };
  };

  const register = (t: Team): request.Test =>
    http()
      .post('/api/auth/local/register')
      .send({ email: t.inviteEmail, password: 'a-long-enough-passphrase', invite_token: t.token });

  const fillSlot = (t: Team): request.Test =>
    asOwner(http().put(`/api/environments/${t.env}/slots/gmail`), t.org).send({ connection_id: gmail });
  const setOrgKey = (t: Team, name: string): request.Test =>
    asOwner(http().put(`/api/platform-keys/${name}`), t.org).send({ value: `${name}-${suffix()}` });
  const connectCluster = (t: Team): request.Test =>
    asOwner(http().post(`/api/orgs/${t.org}/clusters/production/connect`)).send({ app: 'slack' });

  // An org's cluster connection and the Composio account its connect made.
  const clusterIn = async (t: Team): Promise<{ connection: string; account: string }> => {
    await setOrgKey(t, 'composio_api_key').expect(200);
    const before = new Set(composioAccounts.created);
    const connection = (await connectCluster(t).expect(201)).body.connection_id as string;
    const [account] = [...composioAccounts.created].filter((id) => !before.has(id));
    return { connection, account: account! };
  };

  const kept = async (cluster: { connection: string; account: string }): Promise<unknown> => ({
    connection: (await db.query(`SELECT 1 FROM connections WHERE id = $1`, [cluster.connection])).rows.length,
    revoked: composioAccounts.deleted.has(cluster.account),
  });

  // Read on the test's own client, so it sees a connection row until the delete removing it commits.
  const heldByConnection = async (account: string): Promise<boolean> => {
    const { rows } = await db.query<{ credential: string }>(
      `SELECT credential FROM connections WHERE auth_type = 'managed'`,
    );
    return rows.some(
      (row) =>
        (JSON.parse(fernetDecrypt(TEST_FERNET_KEY, row.credential)) as { connected_account_id?: string })
          .connected_account_id === account,
    );
  };

  const leftAtComposio = (before: Set<string>): string[] =>
    [...composioAccounts.created].filter((id) => !before.has(id) && !composioAccounts.deleted.has(id));

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
      name: 'a member removed',
      event: 'org.member_removed',
      send: (t) => asOwner(http().delete(`/api/orgs/${t.org}/members/${member}`)),
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
      gone: { status: 404, detail: 'Invite not found or expired' },
    },
    {
      name: 'a registration against an invite',
      event: 'org.member_joined',
      send: register,
      status: 201,
      heldAt: 'org lock',
      gone: SIGNUP_CLOSED,
    },
    {
      name: 'an environment create',
      event: 'environment.created',
      send: (t) => asOwner(http().post('/api/environments'), t.org).send({ name: `env-${suffix()}` }),
      status: 201,
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
      heldAt: 'org lock',
    },
    {
      name: 'a cluster connection delete',
      prepare: async (t) => {
        await setOrgKey(t, 'composio_api_key').expect(200);
        t.cluster = (await connectCluster(t).expect(201)).body.connection_id as string;
      },
      send: (t) => asOwner(http().delete(`/api/orgs/${t.org}/clusters/connections/${t.cluster ?? ''}`)),
      status: 200,
      heldAt: 'org lock',
    },
    {
      name: 'a workflow deploy',
      event: 'workflow.created',
      send: (t) => asOwner(http().post('/api/deploy'), t.org).send({ workflow_json: webhookDoc('Deployed') }),
      status: 201,
      heldAt: 'org lock',
      refusal: HAS_WORKFLOW,
    },
    {
      name: "a member's workflow draft",
      event: 'workflow.created',
      send: (t) => asMember(http().post('/api/deploy'), t.org).send({ workflow_json: webhookDoc('Drafted') }),
      status: 201,
      heldAt: 'org lock',
      refusal: HAS_WORKFLOW,
    },
  ];

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
    dbUrl = e2eUrl;
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-lock@e2e.local', 'Owner', now(), now()),
              ($2, 'member-lock@e2e.local', 'Member', now(), now()),
              ($3, 'joiner-lock@e2e.local', 'Joiner', now(), now()),
              ($4, 'rival-lock@e2e.local', 'Rival', now(), now())`,
      [owner, member, joiner, rival],
    );
    const personal = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner', true, now(), now()), ($2, 'Member', true, now(), now()),
              ($3, 'Joiner', true, now(), now()), ($4, 'Rival', true, now(), now())`,
      personal,
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $3, $4, 'owner', now()),
              (gen_random_uuid(), $5, $6, 'owner', now()), (gen_random_uuid(), $7, $8, 'owner', now())`,
      [personal[0], owner, personal[1], member, personal[2], joiner, personal[3], rival],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'owner', $2, $3, now()),
              (gen_random_uuid(), $4, 'member', $5, $6, now()),
              (gen_random_uuid(), $7, 'joiner', $8, $9, now()),
              (gen_random_uuid(), $10, 'rival', $11, $12, now())`,
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
        rival,
        hash(rivalKey),
        rivalKey.slice(0, 12),
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
          const created = `ca_lock_${++account}`;
          composioAccounts.created.add(created);
          json(201, { redirect_url: 'https://connect.composio.test/lock', connected_account_id: created });
        } else if (req.method === 'DELETE' && url.startsWith('/api/v3/connected_accounts/')) {
          const deleted = decodeURIComponent(url.slice('/api/v3/connected_accounts/'.length));
          void heldByConnection(deleted).then(
            (held) => {
              if (held) composioAccounts.deletedWhileHeld.add(deleted);
              composioAccounts.deleted.add(deleted);
              json(200, { success: true });
            },
            (err: unknown) => json(500, { error: String(err) }),
          );
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

  afterEach(() => {
    const deletedWhileHeld = [...composioAccounts.deletedWhileHeld];
    composioAccounts.deletedWhileHeld.clear();
    expect(deletedWhileHeld).toEqual([]);
  });

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
    const then = writer.refusal ? 'refuses with 409' : 'removes the org';
    it(`${writer.name} holding the org row when an org delete starts lands first, and the org delete then ${then}`, async () => {
      const t = await team(`${writer.name}, then an org delete`);
      const accountsBefore = new Set(composioAccounts.created);
      await writer.prepare?.(t);
      const landed = (await outcome(t.org, event)).events;
      const held = holdWriter(writer);
      const before = await deadlocks();
      try {
        const writing = statusOf(writer.send(t));
        await held.arrived;
        const deleting = answer(deleteOrg(t.org));
        await lockWaiters(1);
        held.release();
        expect(await writing).toBe(writer.status);
        expect(await deleting).toEqual(
          writer.refusal ? { status: 409, detail: writer.refusal } : { status: 200, detail: undefined },
        );
      } finally {
        held.restore();
      }
      expect(await outcome(t.org, event)).toEqual({
        org: writer.refusal !== undefined,
        events: writer.event ? landed + 1 : 0,
      });
      expect(leftAtComposio(accountsBefore)).toEqual([]);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it(`${writer.name} started while an org delete is in flight waits for it and answers ${(writer.gone ?? ORG_GONE).status}`, async () => {
      const t = await team(`an org delete, then ${writer.name}`);
      const accountsBefore = new Set(composioAccounts.created);
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
        expect(await writing).toEqual(writer.gone ?? ORG_GONE);
      } finally {
        held.restore();
      }
      expect(await outcome(t.org, event)).toEqual({ org: false, events: landed });
      expect(leftAtComposio(accountsBefore)).toEqual([]);
      expect(await deadlocksSince(before)).toBe(0);
    });
  }

  it('a write holding the org row lets an org rename and another write under the org go ahead', async () => {
    const t = await team('Writes side by side');
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

  describe("a connection delete and an org delete over the connection's slots in two of the org's environments", () => {
    interface ConnectionDeleter {
      app: string;
      connect: () => Promise<{ owner: string | null; connection: string }>;
      remove: (owner: string | null, connection: string) => request.Test;
      status: number;
    }

    const personal = async (): Promise<{ owner: null; connection: string }> => {
      const created = await asOwner(http().post('/api/connections'))
        .send({ provider: 'gmail', credential: 'owner-gmail' })
        .expect(201);
      return { owner: null, connection: created.body.id as string };
    };
    const cluster = async (): Promise<{ owner: string; connection: string }> => {
      const t = await team('Cluster owner');
      await setOrgKey(t, 'composio_api_key').expect(200);
      return { owner: t.org, connection: (await connectCluster(t).expect(201)).body.connection_id as string };
    };

    const DELETERS: Array<[string, ConnectionDeleter]> = [
      [
        'a personal connection delete with force',
        {
          app: 'gmail',
          connect: personal,
          remove: (_, connection) => asOwner(http().delete(`/api/connections/${connection}?force=true`)),
          status: 200,
        },
      ],
      [
        'a cluster connection delete',
        {
          app: 'slack',
          connect: cluster,
          remove: (owner, connection) =>
            asOwner(http().delete(`/api/orgs/${owner ?? ''}/clusters/connections/${connection}`)),
          status: 200,
        },
      ],
      [
        "a cluster connect replacing the cluster's connection",
        {
          app: 'slack',
          connect: cluster,
          remove: (owner) =>
            asOwner(http().post(`/api/orgs/${owner ?? ''}/clusters/production/connect`)).send({
              app: 'slack',
            }),
          status: 201,
        },
      ],
      [
        "the delete of the cluster connection's own org",
        {
          app: 'slack',
          connect: cluster,
          remove: (owner) => deleteOrg(owner ?? ''),
          status: 200,
        },
      ],
    ];

    const slotIn = (org: string, env: string, app: string, connection: string): request.Test =>
      asOwner(http().put(`/api/environments/${env}/slots/${app}`), org).send({ connection_id: connection });

    // Retried until the org delete reaches the environments one then two, by heap and by name, and the connection's own scan reaches its slot in two first.
    const crossedSlots = async (
      deleter: ConnectionDeleter,
      connection: string,
    ): Promise<{ org: string; one: string; two: string }> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const created = await asOwner(http().post('/api/orgs')).send({ name: 'Crossed slots' }).expect(201);
        const org = created.body.id as string;
        const envIn = async (name: string): Promise<string> =>
          (await asOwner(http().post('/api/environments'), org).send({ name }).expect(201)).body.id as string;
        const one = await envIn(`a-one-${suffix()}`);
        const two = await envIn(`b-two-${suffix()}`);
        await slotIn(org, two, deleter.app, connection).expect(200);
        await slotIn(org, one, deleter.app, connection).expect(200);
        const scans = await db.query<{ envs: string[]; slots: string[] }>(
          `SELECT (SELECT array_agg(id ORDER BY ctid) FROM environments WHERE org_id = $1 AND id = ANY($3::uuid[])) AS envs,
                  (SELECT array_agg(environment_id ORDER BY ctid) FROM environment_connections
                    WHERE connection_id = $2) AS slots`,
          [org, connection, [one, two]],
        );
        const { envs, slots } = scans.rows[0]!;
        if (envs.join() === [one, two].join() && slots.join() === [two, one].join()) return { org, one, two };
        await deleteOrg(org).expect(200);
      }
      throw new Error('never got the two slots in the crossed heap orders');
    };

    it.each(DELETERS)(
      '%s and an org delete, with the slot the org delete reaches first held, both complete',
      async (_, deleter) => {
        const { owner, connection } = await deleter.connect();
        const { org, one } = await crossedSlots(deleter, connection);
        const slotHolder = new Client({ connectionString: dbUrl });
        await slotHolder.connect();
        const before = await deadlocks();
        try {
          await slotHolder.query('BEGIN');
          await slotHolder.query(
            `SELECT 1 FROM environment_connections WHERE environment_id = $1 AND app = $2 FOR KEY SHARE`,
            [one, deleter.app],
          );
          const orgDeleting = answer(deleteOrg(org));
          await lockWaiters(1);
          const removing = answer(deleter.remove(owner, connection));
          await lockWaiters(2);
          await slotHolder.query('COMMIT');
          expect({ org: await orgDeleting, connection: await removing }).toEqual({
            org: { status: 200, detail: undefined },
            connection: { status: deleter.status, detail: undefined },
          });
        } finally {
          await slotHolder.end();
        }
        const left = await db.query(
          `SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1) AS org,
                  EXISTS (SELECT 1 FROM connections WHERE id = $2) AS connection,
                  (SELECT count(*)::int FROM environment_connections WHERE connection_id = $2) AS slots`,
          [org, connection],
        );
        expect(left.rows[0]).toEqual({ org: false, connection: false, slots: 0 });
        expect(await deadlocksSince(before)).toBe(0);
      },
    );

    it("a slot assign of an org's cluster connection, in another org's environment it fills, started while the org's delete holds the connection waits for it and answers 404", async () => {
      const t = await team('Cluster connection under an org delete');
      const { connection } = await clusterIn(t);
      const other = await team('Slot in another org');
      await slotIn(other.org, other.env, 'slack', connection).expect(200);
      const held = bounded(
        holdQuery(/SELECT id, org_id = \$1 AS own FROM environments/, 'after'),
        'an org delete',
      );
      const before = await deadlocks();
      try {
        const deleting = statusOf(deleteOrg(t.org));
        await held.arrived;
        const assigning = answer(slotIn(other.org, other.env, 'slack', connection));
        await lockWaiters(1);
        held.release();
        expect({ deleting: await deleting, assigning: await assigning }).toEqual({
          deleting: 200,
          assigning: { status: 404, detail: 'Connection not found' },
        });
      } finally {
        held.restore();
      }
      const slots = await db.query(`SELECT 1 FROM environment_connections WHERE connection_id = $1`, [
        connection,
      ]);
      expect(slots.rows).toEqual([]);
      expect(await deadlocksSince(before)).toBe(0);
    });

    const deleted = { status: 200, detail: undefined };

    it.each([
      [
        'the second waiting for the first held just after its first environment lock',
        /FROM environments WHERE id = \$1 FOR /,
        async (): Promise<void> => {
          await lockWaiters(1);
        },
      ],
      [
        'the second going first past the first held just after reading its environments',
        /SELECT id, org_id = \$1 AS own FROM environments/,
        async (second: Promise<unknown>): Promise<void> => {
          expect(await within(second)).toEqual(deleted);
        },
      ],
    ])(
      "two org deletes, each org's cluster connection filling a slot in the other's environment, %s, both complete",
      async (_, at, meanwhile) => {
        const one = await team('Crossed clusters, one');
        const two = await team('Crossed clusters, two');
        const clusters = [await clusterIn(one), await clusterIn(two)];
        // The first locks the lowest id of all, the second's environment its connection fills, before its own lowest, which the second's connection fills.
        const lowestIn = async (orgs: string[]): Promise<{ id: string; org_id: string }> =>
          (
            await db.query<{ id: string; org_id: string }>(
              `SELECT id, org_id FROM environments WHERE org_id = ANY($1::uuid[]) ORDER BY id LIMIT 1`,
              [orgs],
            )
          ).rows[0]!;
        const lowest = await lowestIn([one.org, two.org]);
        const [second, first] = lowest.org_id === one.org ? [one, two] : [two, one];
        const [secondCluster, firstCluster] = second === one ? clusters : [clusters[1], clusters[0]];
        const firstLowest = await lowestIn([first.org]);
        await slotIn(second.org, lowest.id, 'slack', firstCluster!.connection).expect(200);
        await slotIn(first.org, firstLowest.id, 'slack', secondCluster!.connection).expect(200);
        const held = bounded(holdQuery(at, 'after'), 'the first org delete');
        const before = await deadlocks();
        try {
          const firstDeleting = answer(deleteOrg(first.org));
          await held.arrived;
          await expect(
            db.query(`SELECT 1 FROM connections WHERE org_id = $1 FOR KEY SHARE NOWAIT`, [first.org]),
          ).rejects.toMatchObject({ code: '55P03' });
          const secondDeleting = answer(deleteOrg(second.org));
          await meanwhile(secondDeleting);
          held.release();
          expect({ first: await firstDeleting, second: await secondDeleting }).toEqual({
            first: deleted,
            second: deleted,
          });
        } finally {
          held.restore();
        }
        const left = await db.query(
          `SELECT (SELECT count(*)::int FROM organizations WHERE id = ANY($1::uuid[])) AS orgs,
                  (SELECT count(*)::int FROM connections WHERE id = ANY($2::uuid[])) AS connections`,
          [[one.org, two.org], clusters.map((c) => c.connection)],
        );
        expect(left.rows[0]).toEqual({ orgs: 0, connections: 0 });
        expect(clusters.map((c) => composioAccounts.deleted.has(c.account))).toEqual([true, true]);
        expect(await deadlocksSince(before)).toBe(0);
      },
    );

    it("an org delete holding another org's environment its cluster connection fills a slot in lets a rename of that environment go ahead", async () => {
      const t = await team('Org delete beside a rename of another org environment');
      const { connection } = await clusterIn(t);
      const other = await team('Environment the cluster connection fills');
      await slotIn(other.org, other.env, 'slack', connection).expect(200);
      const held = gateEmits('org.deleted');
      try {
        const deleting = statusOf(deleteOrg(t.org));
        await held.arrived(0);
        await expect(
          db.query(`SELECT 1 FROM environments WHERE id = $1 FOR UPDATE NOWAIT`, [other.env]),
        ).rejects.toMatchObject({ code: '55P03' });
        const renaming = await within(
          statusOf(
            asOwner(http().patch(`/api/environments/${other.env}`), other.org).send({
              name: `beside-${suffix()}`,
            }),
          ),
        );
        expect(renaming).toBe(200);
        held.release(0);
        expect(await deleting).toBe(200);
      } finally {
        held.restore();
      }
    });

    it('a slot assign started while a connection delete holds the connection waits for it and answers 404', async () => {
      const t = await team('Assign beside a connection delete');
      const { connection } = await personal();
      const held = bounded(holdQuery(/FROM organizations\s+WHERE id IN/, 'after'), 'a connection delete');
      const before = await deadlocks();
      try {
        const removing = statusOf(asOwner(http().delete(`/api/connections/${connection}?force=true`)));
        await held.arrived;
        const assigning = answer(slotIn(t.org, t.env, 'gmail', connection));
        await lockWaiters(1);
        held.release();
        expect(await removing).toBe(200);
        expect(await assigning).toEqual({ status: 404, detail: 'Connection not found' });
      } finally {
        held.restore();
      }
      const slots = await db.query(`SELECT 1 FROM environment_connections WHERE connection_id = $1`, [
        connection,
      ]);
      expect(slots.rows).toEqual([]);
      expect(await deadlocksSince(before)).toBe(0);
    });
  });

  describe("a slot assign and its environment's delete", () => {
    const LOCK_NOT_AVAILABLE = { code: '55P03' };
    const slotsIn = async (env: string): Promise<unknown[]> =>
      (await db.query(`SELECT 1 FROM environment_connections WHERE environment_id = $1`, [env])).rows;
    const removeEnv = (t: Team): request.Test => asOwner(http().delete(`/api/environments/${t.env}`), t.org);

    it('a slot assign started while an environment delete holds the environment waits for it and answers 404', async () => {
      const t = await team('Assign beside an environment delete');
      const held = gateEmits('environment.deleted');
      const before = await deadlocks();
      try {
        const removing = statusOf(removeEnv(t));
        await held.arrived(0);
        await expect(
          db.query(`SELECT 1 FROM environments WHERE id = $1 FOR KEY SHARE NOWAIT`, [t.env]),
        ).rejects.toMatchObject(LOCK_NOT_AVAILABLE);
        const assigning = answer(fillSlot(t));
        await lockWaiters(1);
        held.release(0);
        expect({ removing: await removing, assigning: await assigning }).toEqual({
          removing: 200,
          assigning: { status: 404, detail: 'Environment not found' },
        });
      } finally {
        held.restore();
      }
      expect(await slotsIn(t.env)).toEqual([]);
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a slot assign holding its environment when the environment delete starts lands first, and the delete then removes the slot', async () => {
      const t = await team('Environment delete beside an assign');
      const held = bounded(
        holdQuery(/SELECT connection_id FROM environment_connections WHERE environment_id/),
        'a slot assign',
      );
      const before = await deadlocks();
      try {
        const assigning = statusOf(fillSlot(t));
        await held.arrived;
        await expect(
          db.query(`SELECT 1 FROM environments WHERE id = $1 FOR UPDATE NOWAIT`, [t.env]),
        ).rejects.toMatchObject(LOCK_NOT_AVAILABLE);
        const removing = statusOf(removeEnv(t));
        await lockWaiters(1);
        held.release();
        expect({ assigning: await assigning, removing: await removing }).toEqual({
          assigning: 200,
          removing: 200,
        });
      } finally {
        held.restore();
      }
      expect(await slotsIn(t.env)).toEqual([]);
      expect(await deadlocksSince(before)).toBe(0);
    });
  });

  describe('an invite accept or a registration against it beside a revoke or another accept of the same invite', () => {
    const accept = (who: typeof asJoiner, t: Team): request.Test =>
      who(http().post(`/api/orgs/invites/${t.token}/accept`));
    const revoke = (t: Team): request.Test =>
      asOwner(http().delete(`/api/orgs/${t.org}/invites/${t.invite}`));
    const spent = { status: 404, detail: 'Invite not found or expired' };

    const holdsInvite = (t: Team): Promise<void> =>
      expect(
        db.query(`SELECT 1 FROM org_invites WHERE id = $1 FOR UPDATE NOWAIT`, [t.invite]),
      ).rejects.toMatchObject({ code: '55P03' });

    // Parks an accept by the joiner at its membership insert, past its invite lock: the insert's foreign-key check waits for the joiner's row.
    const parkJoiner = async (): Promise<Client> => {
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [joiner]);
      return holder;
    };

    const settled = async (
      t: Team,
    ): Promise<{ joined: string[]; invite: string | null; revoked: number }> => {
      const { rows } = await db.query<{ joined: string[] | null; invite: string | null; revoked: number }>(
        `SELECT (SELECT array_agg(user_id::text ORDER BY user_id) FROM org_members
                  WHERE org_id = $1 AND user_id = ANY($2::uuid[])) AS joined,
                (SELECT coalesce(accepted_by::text, 'pending') FROM org_invites WHERE id = $3) AS invite,
                (SELECT count(*)::int FROM domain_events
                  WHERE type = 'org.invite_revoked' AND subject_id = $3::text) AS revoked`,
        [t.org, [joiner, rival], t.invite],
      );
      const row = rows[0]!;
      return { joined: row.joined ?? [], invite: row.invite, revoked: row.revoked };
    };

    // Read on the test's own client, so an account shows only once the registration making it commits.
    const registered = async (
      t: Team,
    ): Promise<{ accounts: number; members: number; invite: string | null }> =>
      (
        await db.query<{ accounts: number; members: number; invite: string | null }>(
          `SELECT (SELECT count(*)::int FROM users WHERE email = $1) AS accounts,
                  (SELECT count(*)::int FROM org_members m JOIN users u ON u.id = m.user_id
                    WHERE m.org_id = $2 AND u.email = $1) AS members,
                  (SELECT coalesce(u.email, 'pending') FROM org_invites i
                     LEFT JOIN users u ON u.id = i.accepted_by WHERE i.id = $3) AS invite`,
          [t.inviteEmail, t.org, t.invite],
        )
      ).rows[0]!;

    it('an invite revoke holding the invite when an accept of it starts lands first, and the accept answers 404 as for a spent invite', async () => {
      const t = await team('Revoke, then accept');
      const held = gateEmits('org.invite_revoked');
      const before = await deadlocks();
      try {
        const revoking = statusOf(revoke(t));
        await held.arrived(0);
        await holdsInvite(t);
        const accepting = answer(accept(asJoiner, t));
        await lockWaiters(1);
        held.release(0);
        expect({ revoke: await revoking, accept: await accepting }).toEqual({ revoke: 200, accept: spent });
      } finally {
        held.restore();
      }
      expect(await settled(t)).toEqual({ joined: [], invite: null, revoked: 1 });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('an invite accept holding the invite when a revoke of it starts lands first, and the revoke answers 404', async () => {
      const t = await team('Accept, then revoke');
      const holder = await parkJoiner();
      const before = await deadlocks();
      try {
        const accepting = answer(accept(asJoiner, t));
        await lockWaiters(1);
        await holdsInvite(t);
        const revoking = answer(revoke(t));
        await lockWaiters(2);
        await holder.query('COMMIT');
        expect({ accept: (await accepting).status, revoke: await revoking }).toEqual({
          accept: 200,
          revoke: { status: 404, detail: 'Invite not found' },
        });
      } finally {
        await holder.end();
      }
      expect(await settled(t)).toEqual({ joined: [joiner], invite: joiner, revoked: 0 });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('an invite accept holding the invite when a second account accepts it lands first, and the second answers 404 as for a spent invite', async () => {
      const t = await team('Two accepts of one invite');
      const holder = await parkJoiner();
      const before = await deadlocks();
      try {
        const first = answer(accept(asJoiner, t));
        await lockWaiters(1);
        await holdsInvite(t);
        const second = answer(accept(asRival, t));
        await lockWaiters(2);
        await holder.query('COMMIT');
        expect({ first: (await first).status, second: await second }).toEqual({ first: 200, second: spent });
      } finally {
        await holder.end();
      }
      expect(await settled(t)).toEqual({ joined: [joiner], invite: joiner, revoked: 0 });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('an invite revoke holding the invite when a registration against it starts lands first, and the registration is refused as signup_closed, creating no account', async () => {
      const t = await team('Revoke, then register');
      const held = gateEmits('org.invite_revoked');
      const before = await deadlocks();
      try {
        const revoking = statusOf(revoke(t));
        await held.arrived(0);
        await holdsInvite(t);
        const registering = answer(register(t));
        await lockWaiters(1);
        held.release(0);
        expect({ revoke: await revoking, register: await registering }).toEqual({
          revoke: 200,
          register: SIGNUP_CLOSED,
        });
      } finally {
        held.restore();
      }
      expect(await registered(t)).toEqual({ accounts: 0, members: 0, invite: null });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('an invite accept holding the invite when a registration against it starts lands first, and the registration is refused as signup_closed, creating no account', async () => {
      const t = await team('Accept, then register');
      const holder = await parkJoiner();
      const before = await deadlocks();
      try {
        const accepting = answer(accept(asJoiner, t));
        await lockWaiters(1);
        await holdsInvite(t);
        const registering = answer(register(t));
        await lockWaiters(2);
        await holder.query('COMMIT');
        expect({ accept: (await accepting).status, register: await registering }).toEqual({
          accept: 200,
          register: SIGNUP_CLOSED,
        });
      } finally {
        await holder.end();
      }
      expect(await registered(t)).toEqual({ accounts: 0, members: 0, invite: 'joiner-lock@e2e.local' });
      expect(await settled(t)).toEqual({ joined: [joiner], invite: joiner, revoked: 0 });
      expect(await deadlocksSince(before)).toBe(0);
    });

    it('a registration against an invite holding it when a revoke of it starts lands first, its account committing only with its accept, and the revoke answers 404', async () => {
      const t = await team('Register, then revoke');
      const held = gateEmits('org.member_joined');
      const before = await deadlocks();
      try {
        const registering = statusOf(register(t));
        await held.arrived(0);
        await holdsInvite(t);
        expect(await registered(t)).toEqual({ accounts: 0, members: 0, invite: 'pending' });
        const revoking = answer(revoke(t));
        await lockWaiters(1);
        held.release(0);
        expect({ register: await registering, revoke: await revoking }).toEqual({
          register: 201,
          revoke: { status: 404, detail: 'Invite not found' },
        });
      } finally {
        held.restore();
      }
      expect(await registered(t)).toEqual({ accounts: 1, members: 1, invite: t.inviteEmail });
      expect((await settled(t)).revoked).toBe(0);
      expect(await deadlocksSince(before)).toBe(0);
    });
  });

  it("a cluster connect replacing the connection a concurrent connect has just made deletes that connection's Composio account", async () => {
    const t = await team('Two cluster connects');
    await setOrgKey(t, 'composio_api_key').expect(200);
    const known = new Set(composioAccounts.created);
    const minted = (): string[] => [...composioAccounts.created].filter((id) => !known.has(id));
    const held = bounded(holdQuery(ORG_LOCK), 'a cluster connect');
    const before = await deadlocks();
    try {
      const replacing = connectCluster(t).then((res) => ({
        status: res.status,
        connection: res.body.connection_id as string,
      }));
      await held.arrived;
      expect(minted()).toHaveLength(1);
      const replaced = (await connectCluster(t).expect(201)).body.connection_id as string;
      const [replacingAccount, replacedAccount] = minted();
      held.release();
      const { status, connection } = await replacing;
      expect(status).toBe(201);
      const rows = await db.query(`SELECT id FROM connections WHERE org_id = $1`, [t.org]);
      expect({ rows: rows.rows, replaced: replaced !== connection }).toEqual({
        rows: [{ id: connection }],
        replaced: true,
      });
      expect({
        replaced: composioAccounts.deleted.has(replacedAccount!),
        replacing: composioAccounts.deleted.has(replacingAccount!),
      }).toEqual({ replaced: true, replacing: false });
    } finally {
      held.restore();
    }
    expect(await deadlocksSince(before)).toBe(0);
  });

  it("a cluster connection delete the org's delete follows at once still deletes the connection's Composio account, with the key the org had", async () => {
    const t = await team('Cluster connection delete, then the org delete');
    const cluster = await clusterIn(t);
    const held = bounded(holdQuery(/FROM platform_secrets/), 'a cluster connection delete');
    const before = await deadlocks();
    try {
      const removing = statusOf(
        asOwner(http().delete(`/api/orgs/${t.org}/clusters/connections/${cluster.connection}`)),
      );
      await held.arrived;
      const deleting = statusOf(deleteOrg(t.org));
      await lockWaiters(1);
      held.release();
      expect({ removing: await removing, deleting: await deleting }).toEqual({
        removing: 200,
        deleting: 200,
      });
    } finally {
      held.restore();
    }
    expect(await kept(cluster)).toEqual({ connection: 0, revoked: true });
    expect(await deadlocksSince(before)).toBe(0);
  });

  it("a cluster connection delete and an org delete still delete when the org's Composio key no longer decrypts, leaving the accounts at Composio", async () => {
    const t = await team('Composio key that no longer decrypts');
    const production = await clusterIn(t);
    const staging = await asOwner(http().post(`/api/orgs/${t.org}/clusters/staging/connect`))
      .send({ app: 'slack' })
      .expect(201);
    await db.query(
      `UPDATE platform_secrets SET secret = $1 WHERE org_id = $2 AND name = 'composio_api_key'`,
      [fernetEncrypt(randomBytes(32).toString('base64url'), 'a key under another FERNET_KEY'), t.org],
    );
    const deletes = composioAccounts.deleted.size;
    const removing = await answer(
      asOwner(http().delete(`/api/orgs/${t.org}/clusters/connections/${production.connection}`)),
    );
    const deleting = await answer(deleteOrg(t.org));
    expect({ removing, deleting }).toEqual({
      removing: { status: 200, detail: undefined },
      deleting: { status: 200, detail: undefined },
    });
    const left = await db.query(
      `SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1) AS org,
              (SELECT count(*)::int FROM connections WHERE id = ANY($2::uuid[])) AS connections`,
      [t.org, [production.connection, staging.body.connection_id as string]],
    );
    expect({ ...left.rows[0], deletes: composioAccounts.deleted.size - deletes }).toEqual({
      org: false,
      connections: 0,
      deletes: 0,
    });
  });

  it('an org delete that fails after deleting its cluster connections keeps them and their Composio accounts', async () => {
    const t = await team('Fails after its cluster connections');
    const cluster = await clusterIn(t);
    const events = app.get(EventsService);
    const emit = events.emit.bind(events);
    const failing = jest
      .spyOn(events, 'emit')
      .mockImplementation((em, event: DomainEventInput) =>
        event.type === 'org.deleted' ? Promise.reject(new Error('the org delete fails')) : emit(em, event),
      );
    try {
      expect((await answer(deleteOrg(t.org))).status).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect(await kept(cluster)).toEqual({ connection: 1, revoked: false });
  });

  it('an org delete refused while the org has a workflow keeps its cluster connections and their Composio accounts', async () => {
    const t = await team('Refused with a cluster connection');
    const cluster = await clusterIn(t);
    await asOwner(http().post('/api/deploy'), t.org)
      .send({ workflow_json: webhookDoc('Keeps the org') })
      .expect(201);
    expect(await answer(deleteOrg(t.org))).toEqual({ status: 409, detail: HAS_WORKFLOW });
    expect(await kept(cluster)).toEqual({ connection: 1, revoked: false });
  });

  it("a workflow created while an org delete waits for the org row is counted, so a promote of it lands and the org delete answers 409, keeping the org's cluster connection", async () => {
    const t = await team('Promote beside an org delete');
    const cluster = await clusterIn(t);
    const writer = new Client({ connectionString: dbUrl });
    await writer.connect();
    const promoted = gateEmits('workflow.promoted');
    const before = await deadlocks();
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`, [t.org]);
      const deleting = answer(deleteOrg(t.org));
      await lockWaiters(1);
      const deployed = await asOwner(http().post('/api/deploy'), t.org)
        .send({ workflow_json: webhookDoc('Created beside an org delete') })
        .expect(201);
      const workflow = deployed.body.workflow_id as string;
      const listed = await asOwner(http().get(`/api/workflows/${workflow}/versions`), t.org).expect(200);
      const [v1] = listed.body.versions as Array<{ id: string }>;
      const promoting = statusOf(
        asOwner(http().post(`/api/workflows/${workflow}/promote`), t.org).send({
          environment: t.envName,
          version_id: v1!.id,
        }),
      );
      await promoted.arrived(0);
      await expect(
        db.query(`SELECT 1 FROM environments WHERE id = $1 FOR UPDATE NOWAIT`, [t.env]),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('COMMIT');
      const refused = await within(deleting);
      promoted.release(0);
      expect({ refused, promoting: await promoting }).toEqual({
        refused: { status: 409, detail: HAS_WORKFLOW },
        promoting: 201,
      });
      const still = await db.query(`SELECT org_id FROM workflows WHERE id = $1`, [workflow]);
      expect(still.rows).toEqual([{ org_id: t.org }]);
    } finally {
      promoted.restore();
      await writer.end();
    }
    expect(await kept(cluster)).toEqual({ connection: 1, revoked: false });
    expect(await deadlocksSince(before)).toBe(0);
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
