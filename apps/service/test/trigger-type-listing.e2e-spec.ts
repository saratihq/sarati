import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { mintSession } from '../src/auth/local/local-session';
import { configureApp } from '../src/bootstrap';
import { ComposeCatalogService } from '../src/compose/compose-catalog.service';
import { seedDefaultEnvironments } from '../src/environments/default-environments';
import type { MergeResolution } from '../src/ir/merge';
import { TriggerCatalogService } from '../src/triggers/trigger-catalog.service';
import { BranchService } from '../src/workflows/branch.service';
import { insertApiKey } from './support/api-keys';
import { listenOnLoopback } from './support/listen';
import { deferred, reached } from './support/lock-probes';
import { insertPersonalOrgs } from './support/personal-org';
import { setPlatformKey } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const SECRET = 'trigger-type-listing-session-secret';
const LISTED_KEY = 'ck_e2e_listed';
const DOWN_KEY = 'ck_e2e_down';
const REAL = 'gmail.gmail_new_gmail_message';
const TYPO = 'gmail.gmail_new_gmail_mesage';

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean };

/** An app trigger's type against the picker's trigger list, Composio's part included: refused where it can be read and lacks it, flagged where it can't. */
describe('a trigger type against the workspace trigger list (e2e, isolated DB, 127.0.0.1 Composio)', () => {
  let app: INestApplication;
  let db: Client;
  let composio: Server;
  const listings: string[] = [];
  const clients: McpClient[] = [];

  const userId = randomUUID();
  const memberId = randomUUID();
  const outsiderId = randomUUID();
  const personal = randomUUID();
  const outsiders = randomUUID();
  const listed = randomUUID();
  const down = randomUUID();
  const keys = new Map<string, string>();
  let memberKey = '';
  let downMemberKey = '';
  let secretBefore: string | undefined;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const as = (org: string, r: request.Test): request.Test =>
    r.set('Authorization', `Bearer ${keys.get(org)!}`);

  const doc = (triggerType: string): Record<string, unknown> => ({
    version: '1',
    name: 'listens',
    description: '',
    nodes: [
      {
        id: 'start',
        name: 'Start',
        node_type: triggerType,
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'say',
        name: 'Say',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['hi'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      { id: 'start->say', source_node_id: 'start', source_port: 0, target_node_id: 'say', target_port: 0 },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });
  const hint = (type: string): string =>
    `"${type}" is not a known trigger type — pick one from the trigger picker, or search the catalog for kind "trigger" and copy its exact "type"; the built-in ones are orchestr:trigger, orchestr:webhook, orchestr:schedule, orchestr:chat, orchestr:tool_trigger`;
  const unknown = (type: string): string =>
    `Node "start" is this workflow's trigger, but ${hint(type)}. As it is, the trigger never fires.`;
  const lead = (type: string): string =>
    `Node "start" is this workflow's trigger, "${type}", an app trigger only Composio can fire`;
  const unchecked = (type: string, org: string): Record<string, unknown> => ({
    code: 'trigger_type_unverified',
    node_id: 'start',
    node_name: 'Start',
    node_type: type,
    message:
      org === down
        ? `${lead(type)}, and Composio's list of app triggers could not be read just now — the listing failed or did not answer in time — so nothing refuses it; if Composio lists no such trigger, it never fires.`
        : `${lead(type)}, and this workspace has no Composio key: its list of app triggers can't be checked, so nothing refuses it; it can't fire until the workspace has a Composio key, and then only if Composio lists it.`,
  });

  const workflowIn = async (org: string): Promise<string> =>
    (
      await as(
        org,
        http()
          .post('/api/deploy')
          .send({ workflow_json: doc('orchestr:trigger') }),
      ).expect(201)
    ).body.workflow_id as string;
  const commit = async (
    org: string,
    wf: string,
    document: Record<string, unknown>,
    branch = 'main',
  ): Promise<request.Response> => {
    const head = await as(org, http().get(`/api/workflows/${wf}/branches/${branch}/head`)).expect(200);
    return as(
      org,
      http()
        .post(`/api/workflows/${wf}/commit`)
        .send({
          workflow_ir: document,
          branch,
          base_version_id: (head.body.head as { version_id: string }).version_id,
        }),
    );
  };
  const save = (org: string, wf: string, type: string, branch = 'main'): Promise<request.Response> =>
    commit(org, wf, doc(type), branch);
  const retype = (org: string, type: string): request.Test =>
    as(
      org,
      http()
        .post('/api/compose/apply-ops')
        .send({
          ir: doc('orchestr:trigger'),
          ops: [{ op: 'update_node', node_id: 'start', node_type: type }],
        }),
    );

  const callTool = (
    org: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> =>
    callToolWith({ Authorization: `Bearer ${keys.get(org)!}` }, name, args);

  async function toolResult(
    headers: Record<string, string>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const client = new McpClient({ name: 'trigger-listing-e2e', version: '1.0.0' });
    clients.push(client);
    const { port } = app.getHttpServer().address() as AddressInfo;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers },
      }),
    );
    // Listed first, so the client checks the result against the schema the server advertises.
    await client.listTools();
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }
  async function callToolWith(
    headers: Record<string, string>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await toolResult(headers, name, args);
    expect(result.isError).toBeFalsy();
    return result.structuredContent!;
  }
  const sessionOf = async (user: string, org: string): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${(await mintSession(user, SECRET)).token}`,
    'X-Org-Id': org,
  });
  const validate = (org: string, type: string): Promise<Record<string, unknown>> =>
    callTool(org, 'orchestr_validate', { workflow_ir: doc(type) });

  /** A workflow whose `lane` branch made its trigger `laneType` while main made it the chat trigger, and a review of lane into main. */
  async function conflictingLane(org: string, laneType = REAL): Promise<{ wf: string; review: string }> {
    const wf = await workflowIn(org);
    await as(org, http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' })).expect(201);
    await save(org, wf, laneType, 'lane').then((res) => expect(res.status).toBe(201));
    await save(org, wf, 'orchestr:chat').then((res) => expect(res.status).toBe(201));
    const review = await as(
      org,
      http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' }),
    ).expect(201);
    return { wf, review: review.body.id as string };
  }
  const resolvedTo = (type: string): MergeResolution[] => [
    { node_id: 'start', field_path: 'node_type', choice: 'custom', value: type },
  ];
  const mergeDoors = (
    org: string,
    wf: string,
    review: string,
    resolutions = resolvedTo(TYPO),
  ): request.Test[] => [
    as(
      org,
      http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main', resolutions }),
    ),
    as(
      org,
      http().post(`/api/workflows/${wf}/branches/lane/update`).send({ from_branch: 'main', resolutions }),
    ),
    as(org, http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({ resolutions })),
  ];
  /** Makes `document` `branch`'s head as a version saved before the gate refused it. */
  const seedHead = async (wf: string, branch: string, document: Record<string, unknown>): Promise<void> => {
    const { rows } = await db.query<{ id: string; branch_id: string }>(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, workflow_ir, branch_id, parent_id, commit_message, created_at)
       SELECT gen_random_uuid(), v.workflow_id, v.version_number + 1, $3::json, $3::json, b.id, v.id, 'saved earlier', now()
         FROM workflow_branches b JOIN workflow_versions v ON v.id = b.head_version_id
        WHERE b.workflow_id = $1 AND b.name = $2
       RETURNING id, branch_id`,
      [wf, branch, JSON.stringify(document)],
    );
    await db.query(`UPDATE workflow_branches SET head_version_id = $1 WHERE id = $2`, [
      rows[0]!.id,
      rows[0]!.branch_id,
    ]);
  };
  const written = async (wf: string): Promise<unknown[]> =>
    (
      await db.query(
        `SELECT b.name, b.head_version_id, count(v.id)::int AS versions
           FROM workflow_branches b LEFT JOIN workflow_versions v ON v.branch_id = b.id
          WHERE b.workflow_id = $1 GROUP BY b.name, b.head_version_id ORDER BY b.name`,
        [wf],
      )
    ).rows;

  beforeAll(async () => {
    composio = createServer((req, res) => {
      const key = String(req.headers['x-api-key'] ?? '');
      const path = (req.url ?? '').split('?')[0];
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (key !== LISTED_KEY) {
        if (path === '/api/v3/triggers_types') listings.push(key);
        json(503, { error: 'unavailable' });
      } else if (path === '/api/v3/triggers_types') {
        listings.push(key);
        json(200, {
          items: [
            {
              slug: 'GMAIL_NEW_GMAIL_MESSAGE',
              name: 'New message',
              toolkit: { slug: 'gmail' },
              type: 'poll',
            },
          ],
          next_cursor: null,
        });
      } else if (path === '/api/v3/toolkits') {
        json(200, { items: [{ slug: 'gmail', name: 'gmail', composio_managed_auth_schemes: ['OAUTH2'] }] });
      } else {
        json(404, { error: `unexpected ${req.method ?? ''} ${path}` });
      }
    });
    await new Promise<void>((resolve) => composio.listen(0, '127.0.0.1', resolve));

    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'listing@e2e.local', 'Listing', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'member@e2e.local', 'Member', now(), now())`,
      [memberId],
    );
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'outsider@e2e.local', 'Outsider', now(), now())`,
      [outsiderId],
    );
    await insertPersonalOrgs(
      db,
      { id: personal, userId, name: 'Listing' },
      { id: outsiders, userId: outsiderId, name: 'Outsider' },
    );
    for (const [org, name] of [
      [listed, 'Listed'],
      [down, 'Down'],
    ] as const) {
      await db.query(
        `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, $2, false, now(), now())`,
        [org, name],
      );
      await db.query(
        `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
        [org, userId],
      );
      await seedDefaultEnvironments(db, org);
    }
    for (const org of [personal, listed, down]) keys.set(org, await insertApiKey(db, userId, org));
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
      [listed, memberId],
    );
    memberKey = await insertApiKey(db, memberId, listed);
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
      [down, memberId],
    );
    downMemberKey = await insertApiKey(db, memberId, down);

    Object.assign(process.env, {
      DATABASE_URL: e2eUrl,
      PGBOSS_ENABLED: 'false',
      THROTTLE_LIMIT: '10000',
      MOCK_AUTH: 'false',
      CLERK_ISSUER: '',
      DRIFT_POLL_INTERVAL_SECONDS: '0',
      COMPOSIO_BASE_URL: `http://127.0.0.1:${(composio.address() as AddressInfo).port}`,
    });
    secretBefore = process.env.SECRET_KEY;
    process.env.SECRET_KEY = SECRET;
    // More workflows are made here than a route's own limit allows in a minute.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    await setPlatformKey(app, { kind: 'org', orgId: listed }, 'composio_api_key', LISTED_KEY);
    await setPlatformKey(app, { kind: 'org', orgId: down }, 'composio_api_key', DOWN_KEY);
  }, 40_000);

  afterAll(async () => {
    for (const client of clients) await client.close();
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => composio.close((e) => (e ? reject(e) : resolve())));
    delete process.env.COMPOSIO_BASE_URL;
    if (secretBefore === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = secretBefore;
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it("refuses a typo of an app trigger where Composio's listing can be read, and saves the real one, as the composer's retype answers", async () => {
    const wf = await workflowIn(listed);

    for (const type of [TYPO, 'orchestr.webhook']) {
      const refused = await save(listed, wf, type);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'unknown_trigger_type',
        node_type: type,
        detail: unknown(type),
      });
      expect((await retype(listed, type).expect(422)).body.detail).toBe(
        `ops[0] update_node "start": ${hint(type)}`,
      );
      expect(await validate(listed, type)).toMatchObject({
        valid: false,
        errors: [{ code: 'unknown_trigger_type', node_type: type, message: unknown(type) }],
      });
    }
    const run = await as(
      listed,
      http()
        .post('/api/runs/from-ir')
        .send({ workflow_ir: doc(TYPO) }),
    ).expect(400);
    expect(run.body).toMatchObject({
      code: 'compile_failed',
      detail: `Workflow can't run: ${unknown(TYPO)}`,
    });

    const saved = await save(listed, wf, REAL);
    expect(saved.body).not.toHaveProperty('code');
    expect(saved.status).toBe(201);
    await retype(listed, REAL).expect(201);
    expect(await validate(listed, REAL)).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(listings.filter((key) => key === LISTED_KEY)).toHaveLength(1);
  });

  it("saves an app trigger it can't check — no Composio key, or a listing that fails — flagged as unchecked on the save, saying why, and still refuses one naming no app", async () => {
    for (const org of [personal, down]) {
      const wf = await workflowIn(org);
      for (const type of [TYPO, REAL]) {
        const saved = await save(org, wf, type);
        expect(saved.body).not.toHaveProperty('code');
        expect(saved.status).toBe(201);
        expect(saved.body.warnings).toEqual([unchecked(type, org)]);
        const retyped = (await retype(org, type).expect(201)).body.ir as {
          nodes: Array<Record<string, unknown>>;
        };
        expect(retyped.nodes[0]).toMatchObject({ node_type: type, metadata: { trigger: true } });
        const edited = await callTool(org, 'orchestr_edit_workflow', {
          workflow_ir: doc('orchestr:trigger'),
          ops: [{ op: 'update_node', node_id: 'start', node_type: type }],
        });
        expect(edited.applied).toEqual([
          `updated node "start": retyped to "${type}" (parameters replaced) — ${unchecked(type, org).message as string}`,
        ]);
        expect(await validate(org, type)).toMatchObject({
          valid: true,
          errors: [],
          warnings: [unchecked(type, org)],
        });
      }
      const created = await as(
        org,
        http()
          .post('/api/deploy')
          .send({ workflow_json: doc(TYPO) }),
      ).expect(201);
      expect(created.body.warnings).toEqual([unchecked(TYPO, org)]);
      const drafted = await callTool(org, 'orchestr_create_workflow', {
        name: 'listens',
        workflow_ir: doc(TYPO),
      });
      expect(drafted.warnings).toEqual([unchecked(TYPO, org)]);
      if (org === down) {
        const memberDraft = await http()
          .post('/api/deploy')
          .set('Authorization', `Bearer ${downMemberKey}`)
          .send({ workflow_json: doc(TYPO) })
          .expect(201);
        expect(memberDraft.body).toMatchObject({ is_live: false, warnings: [unchecked(TYPO, down)] });
      }
      const head = await as(org, http().get(`/api/workflows/${wf}/branches/main/head`)).expect(200);
      const committed = await callTool(org, 'orchestr_commit', {
        workflow_id: wf,
        workflow_ir: { ...doc(TYPO), description: 'over MCP' },
        branch: 'main',
        base_version_id: (head.body.head as { version_id: string }).version_id,
      });
      expect(committed.warnings).toEqual([unchecked(TYPO, org)]);
      for (const type of ['Acme.new_deal', 'orchestr.webhook', 'gmail.New_Mail']) {
        const refused = await save(org, wf, type);
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ code: 'unknown_trigger_type', detail: unknown(type) });
        expect((await retype(org, type).expect(422)).body.detail).toBe(
          `ops[0] update_node "start": ${hint(type)}`,
        );
      }
    }
    // Asked once, then held back from asking again on every save while the failure is fresh.
    expect(listings.filter((key) => key === DOWN_KEY)).toHaveLength(1);
    expect(listings.filter((key) => key === '')).toHaveLength(0);
  });

  it('reads the trigger list once per save, however many steps the save takes', async () => {
    const asked = jest.spyOn(app.get(ComposeCatalogService), 'authoringFactsFor');
    try {
      const saved = await http()
        .post('/api/deploy')
        .set('Authorization', `Bearer ${memberKey}`)
        .send({ workflow_json: doc(REAL) })
        .expect(201);
      expect(saved.body).toMatchObject({ is_live: false, warnings: [] });
      expect(asked).toHaveBeenCalledTimes(1);

      asked.mockClear();
      const created = await callTool(listed, 'orchestr_create_workflow', {
        name: 'listens',
        workflow_ir: doc(REAL),
      });
      expect(created.warnings).toEqual([]);
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      asked.mockRestore();
    }
  });

  it("refuses a merge resolved into a typo of an app trigger at every merge door where Composio's listing can be read, writing nothing", async () => {
    const { wf, review } = await conflictingLane(listed);
    const conflicted = await as(
      listed,
      http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main' }),
    ).expect(201);
    expect(conflicted.body.conflicts).toMatchObject([{ node_id: 'start', field_path: 'node_type' }]);
    const before = await written(wf);
    const factsFor = jest.spyOn(app.get(BranchService), 'factsFor');

    try {
      for (const door of mergeDoors(listed, wf, review)) {
        const refused = await door;
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({
          code: 'unknown_trigger_type',
          node_type: TYPO,
          detail: unknown(TYPO),
        });
      }
      // The typed-in type is read before each merge's transaction, so none has to read the list again.
      expect(factsFor.mock.calls.map(([, types]) => [...types].sort())).toEqual(
        Array.from({ length: 3 }, () => [REAL, TYPO, 'orchestr:chat'].sort()),
      );
    } finally {
      factsFor.mockRestore();
    }
    expect(await written(wf)).toEqual(before);
    expect(
      (await as(listed, http().get(`/api/workflows/${wf}/reviews/${review}`)).expect(200)).body.status,
    ).toBe('open');
  });

  it("merges one where the listing can't be read at every merge door, each saying its trigger went unchecked", async () => {
    for (const door of [0, 1, 2]) {
      const { wf, review } = await conflictingLane(down);
      const merged = await mergeDoors(down, wf, review)[door]!;
      expect(merged.status).toBe(201);
      expect(merged.body).toMatchObject({ status: 'merged', warnings: [unchecked(TYPO, down)] });
    }
  });

  it("asks Composio's listing for a merge only when what it would merge holds an app trigger nothing in-process decides", async () => {
    const asked = jest.spyOn(app.get(TriggerCatalogService), 'liveTypes');
    try {
      for (const door of [0, 1, 2]) {
        const { wf, review } = await conflictingLane(listed, 'orchestr:webhook');
        asked.mockClear();
        const merged = await mergeDoors(listed, wf, review, resolvedTo('orchestr:trigger'))[door]!;
        expect(merged.status).toBe(201);
        expect(merged.body).toMatchObject({ status: 'merged', warnings: [] });
        expect(asked).not.toHaveBeenCalled();
      }
      const separated = (separator: string): Record<string, unknown> => {
        const document = doc('orchestr:trigger');
        (document.nodes as Array<Record<string, unknown>>)[1]!.parameters = { texts: ['hi'], separator };
        return document;
      };
      const steps = await workflowIn(listed);
      await as(listed, http().post(`/api/workflows/${steps}/branches`).send({ name: 'lane' })).expect(201);
      await commit(listed, steps, separated('-'), 'lane').then((res) => expect(res.status).toBe(201));
      await commit(listed, steps, separated('+')).then((res) => expect(res.status).toBe(201));
      const conflicts = (
        await as(listed, http().post(`/api/workflows/${steps}/branches/lane/merge`))
          .send({ target_branch: 'main' })
          .expect(201)
      ).body.conflicts as Array<{ node_id: string; field_path: string | null }>;
      expect(conflicts).toMatchObject([{ node_id: 'say' }]);
      asked.mockClear();
      const stepResolved = await as(listed, http().post(`/api/workflows/${steps}/branches/lane/merge`))
        .send({
          target_branch: 'main',
          resolutions: conflicts.map((c) => ({
            node_id: c.node_id,
            field_path: c.field_path,
            choice: 'source',
          })),
        })
        .expect(201);
      expect(stepResolved.body).toMatchObject({ status: 'merged', warnings: [] });
      expect(asked).not.toHaveBeenCalled();

      const { wf, review } = await conflictingLane(listed);
      asked.mockClear();
      const merged = await mergeDoors(listed, wf, review, resolvedTo(REAL))[0]!.expect(201);
      expect(merged.body).toMatchObject({ status: 'merged', warnings: [] });
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      asked.mockRestore();
    }
  });

  it('reads the trigger list again when a head moves after a merge read it, and refuses the typo it moved to, writing nothing', async () => {
    const wf = await workflowIn(listed);
    await as(listed, http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' })).expect(201);
    await save(listed, wf, 'orchestr:chat', 'lane').then((res) => expect(res.status).toBe(201));
    const branches = app.get(BranchService);
    const read = branches.factsFor.bind(branches);
    const arrived = deferred();
    const released = deferred();
    const factsFor = jest.spyOn(branches, 'factsFor').mockImplementationOnce(async (id, types) => {
      const facts = await read(id, types);
      arrived.resolve();
      await released.promise;
      return facts;
    });
    try {
      const pending = as(
        listed,
        http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main' }),
      ).then((res) => res);
      await reached(arrived.promise, 'the merge');
      await seedHead(wf, 'lane', doc(TYPO));
      const before = await written(wf);
      released.resolve();

      const refused = await pending;
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'unknown_trigger_type',
        node_type: TYPO,
        detail: unknown(TYPO),
      });
      expect(await written(wf)).toEqual(before);
      expect(factsFor.mock.calls.map(([, types]) => [...types].sort())).toEqual([
        ['orchestr:chat', 'orchestr:trigger'],
        [TYPO, 'orchestr:chat', 'orchestr:trigger'].sort(),
      ]);
    } finally {
      released.resolve();
      factsFor.mockRestore();
    }
  });

  it('answers 409 merge_moved, writing nothing, when a head moves again after the merge read the trigger list for the first move', async () => {
    const wf = await workflowIn(listed);
    await as(listed, http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' })).expect(201);
    await save(listed, wf, 'orchestr:chat', 'lane').then((res) => expect(res.status).toBe(201));
    const branches = app.get(BranchService);
    const read = branches.factsFor.bind(branches);
    let before: unknown[] = [];
    const factsFor = jest
      .spyOn(branches, 'factsFor')
      .mockImplementationOnce(async (id, types) => {
        await seedHead(wf, 'lane', doc('orchestr:webhook'));
        return read(id, types);
      })
      .mockImplementationOnce(async (id, types) => {
        await seedHead(wf, 'lane', doc('orchestr:schedule'));
        before = await written(wf);
        return read(id, types);
      });
    try {
      const moved = await as(
        listed,
        http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main' }),
      );
      expect(moved.status).toBe(409);
      expect(moved.body).toMatchObject({
        code: 'merge_moved',
        detail: 'A branch moved while this merge was being prepared — merge again.',
      });
      expect(await written(wf)).toEqual(before);
      expect(factsFor.mock.calls.map(([, types]) => [...types].sort())).toEqual([
        ['orchestr:chat', 'orchestr:trigger'],
        ['orchestr:chat', 'orchestr:trigger', 'orchestr:webhook'],
      ]);
    } finally {
      factsFor.mockRestore();
    }
  });

  it('reads a review whose clean merge holds an app trigger the listing lacks as NOT mergeable, as its merge refuses it, writing nothing', async () => {
    const wf = await workflowIn(listed);
    await as(listed, http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' })).expect(201);
    await seedHead(wf, 'lane', doc(TYPO));
    const before = await written(wf);

    const opened = await callTool(listed, 'orchestr_open_review', {
      workflow_id: wf,
      source_branch: 'lane',
      target_branch: 'main',
      title: 'lane → main',
    });
    expect(opened.mergeable).toBe(false);
    const refused = await as(
      listed,
      http()
        .post(`/api/workflows/${wf}/reviews/${opened.review_id as string}/merge`)
        .send({}),
    );
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'unknown_trigger_type',
      node_type: TYPO,
      detail: unknown(TYPO),
    });
    expect(await written(wf)).toEqual(before);
  });

  it("judges orchestr_validate given a workflow it can read in that workflow's workspace, as its commit is judged, and otherwise in the caller's", async () => {
    const wf = await workflowIn(listed);
    const owner = await sessionOf(userId, personal);
    const outsider = await sessionOf(outsiderId, outsiders);
    const judged = (
      session: Record<string, string>,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> =>
      callToolWith(session, 'orchestr_validate', { workflow_ir: doc(TYPO), ...args });

    expect(await judged(owner, { workflow_id: wf })).toMatchObject({
      valid: false,
      errors: [{ code: 'unknown_trigger_type', node_type: TYPO, message: unknown(TYPO) }],
    });
    expect((await save(listed, wf, TYPO)).status).toBe(422);
    for (const [session, args] of [
      [owner, {}],
      [owner, { workflow_id: randomUUID() }],
      [outsider, { workflow_id: wf }],
    ] as const) {
      expect(await judged(session, args)).toMatchObject({
        valid: true,
        errors: [],
        warnings: [unchecked(TYPO, personal)],
      });
    }
  });

  it("judges an orchestr_edit_workflow retype given a workflow it can read in that workflow's workspace, as its commit is judged, and otherwise in the caller's", async () => {
    const wf = await workflowIn(listed);
    const owner = await sessionOf(userId, personal);
    const outsider = await sessionOf(outsiderId, outsiders);
    const retyped = (session: Record<string, string>, args: Record<string, unknown>): Promise<ToolResult> =>
      toolResult(session, 'orchestr_edit_workflow', {
        workflow_ir: doc('orchestr:trigger'),
        ops: [{ op: 'update_node', node_id: 'start', node_type: TYPO }],
        ...args,
      });

    const refused = await retyped(owner, { workflow_id: wf });
    expect(refused.isError).toBe(true);
    expect(String(refused.structuredContent?.error)).toBe(`ops[0] update_node "start": ${hint(TYPO)}`);
    expect((await save(listed, wf, TYPO)).status).toBe(422);
    for (const [session, args] of [
      [owner, {}],
      [owner, { workflow_id: randomUUID() }],
      [outsider, { workflow_id: wf }],
    ] as const) {
      const edited = await retyped(session, args);
      expect(edited.isError).toBeFalsy();
      expect(edited.structuredContent?.applied).toEqual([
        `updated node "start": retyped to "${TYPO}" (parameters replaced) — ${unchecked(TYPO, personal).message as string}`,
      ]);
    }
  });
});
