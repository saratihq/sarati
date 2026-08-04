import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { AppModule } from '../src/app.module';
import { compileWorkflowIrDag } from '../src/compiler/compile-ir-dag';
import { ConnectionsService } from '../src/connections/connections.service';
import { UserProvisioningService } from '../src/auth/user-provisioning.service';
import type { WorkflowIR } from '../src/ir/models';
import { AGENT_MODEL_FETCH } from '../src/providers/agent-model-call.provider';
import { type AgentResult } from '../src/runtime/agent';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CALLER_ID = '00000000-0000-0000-0000-000000000001'; // the run tenant (NOT the slot owner)
const OWNER_ID = '00000000-0000-0000-0000-0000000000a2'; // the prod-slot connection's owner
const ORG_ID = '00000000-0000-0000-0000-0000000000b3';
const PROD_ENV_ID = '00000000-0000-0000-0000-0000000000c4';
const STAGING_ENV_ID = '00000000-0000-0000-0000-0000000000c5';
const OWNER_KEY = 'sk-ant-slot-owner'; // distinct from any caller key → proves run-AS-owner

/**
 * The env-slot connection fallback for the agent's model call (ADR 0014 × 0045): an env run
 * resolves the provider SLOT and runs AS its owner — never falling back to the personal pool.
 */
describe('AI agent model call — env-slot connection fallback (ADR 0014 × 0045)', () => {
  let app: INestApplication;
  let db: Client;
  /** Each stubbed provider request — url + injected credential header. */
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  const stubFetch: FetchLike = (input, init) => {
    const url = String(input);
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, headers });
    const res: FetchLikeResponse = {
      status: 200,
      headers: { forEach: (cb) => cb('application/json', 'content-type') },
      text: () =>
        Promise.resolve(
          JSON.stringify({
            content: [{ type: 'text', text: 'hi from the env slot' }],
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
        ),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    return Promise.resolve(res);
  };

  /** An agent workflow whose model carries NO connectionId — the env slot must supply it. */
  const agentDoc = (): WorkflowIR => ({
    version: '1',
    name: 'agent-env-slot',
    description: '',
    nodes: [
      {
        id: 'chat',
        name: 'Chat',
        node_type: 'orchestr:chat',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'agent',
        name: 'Agent',
        node_type: 'orchestr:agent',
        type_version: 1,
        // NO connectionId — the promoted run resolves the provider's env slot.
        parameters: {
          model: { provider: 'claude', model: 'claude-opus-4-8' },
          system_prompt: 'You are helpful.',
          max_steps: 3,
          input: '{{trigger.chatInput}}',
        },
        position: { x: 200, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-in',
        source_node_id: 'chat',
        source_port: 0,
        target_node_id: 'agent',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_MODEL_FETCH)
      .useValue(stubFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    await app.init();
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    // Caller (the run tenant) + a SECOND user who owns the prod slot's connection.
    await app.get(UserProvisioningService).getOrCreateMockUser();
    await db.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      OWNER_ID,
      'owner@example.com',
      'Slot Owner',
    ]);
    // The prod environment's claude account — owned by OWNER_ID, a distinct key.
    const ownerConn = await app.get(ConnectionsService).createToken(OWNER_ID, {
      provider: 'claude',
      credential: { api_key: OWNER_KEY },
      displayName: 'Prod Claude',
    });
    // Org + two environments; only prod gets a claude slot (staging stays empty).
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [ORG_ID, 'Acme']);
    await db.query(`INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $2, $3, true)`, [
      PROD_ENV_ID,
      ORG_ID,
      'production',
    ]);
    await db.query(`INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $2, $3, false)`, [
      STAGING_ENV_ID,
      ORG_ID,
      'staging',
    ]);
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, $2, $3)`,
      [PROD_ENV_ID, 'claude', ownerConn.id],
    );
  }, 30000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('(a) an env-scoped run with NO connectionId resolves the provider slot and runs AS its owner', async () => {
    const plan = compileWorkflowIrDag(agentDoc());
    const result = await app.get(DagInterpreter).run(plan, {
      externalUserId: CALLER_ID, // the caller is NOT the slot owner
      environmentId: PROD_ENV_ID,
      environment: 'production',
      orgId: ORG_ID,
      initialScope: { trigger: { chatInput: 'hello' } },
    });

    const out = result.outputs.agent as AgentResult;
    expect(out.text).toBe('hi from the env slot');
    // The OWNER's decrypted key was injected — a lookup as the caller would have found nothing.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('api.anthropic.com');
    expect(calls[0]!.headers['x-api-key']).toBe(OWNER_KEY);
  });

  it('(b) a Default run (no env) with no connection is still the honest 422', async () => {
    const plan = compileWorkflowIrDag(agentDoc());
    await expect(
      app
        .get(DagInterpreter)
        .run(plan, { externalUserId: CALLER_ID, initialScope: { trigger: { chatInput: 'hi' } } }),
    ).rejects.toThrow(/requires a claude connection/i);
    expect(calls).toHaveLength(0); // never reached the provider
  });

  it('(c) an env run whose provider slot is EMPTY is a hard 428 (never a pool fallback)', async () => {
    const plan = compileWorkflowIrDag(agentDoc());
    await expect(
      app.get(DagInterpreter).run(plan, {
        externalUserId: CALLER_ID,
        environmentId: STAGING_ENV_ID,
        environment: 'staging',
        orgId: ORG_ID,
        initialScope: { trigger: { chatInput: 'hi' } },
      }),
    ).rejects.toThrow(/No "claude" connection in the staging environment/i);
    expect(calls).toHaveLength(0); // resolved to a 428 before any provider call
  });
});
