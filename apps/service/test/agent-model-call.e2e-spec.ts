import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { AppModule } from '../src/app.module';
import { compileWorkflowIrDag } from '../src/compiler/compile-ir-dag';
import { ConnectionsService } from '../src/connections/connections.service';
import { UserProvisioningService } from '../src/auth/user-provisioning.service';
import { AgentModelCallProvider, AGENT_MODEL_FETCH } from '../src/providers/agent-model-call.provider';
import { AGENT_MODEL_CALL, type AgentResult } from '../src/runtime/agent';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * ADR 0045 §5 — the agent model seam on the REAL {@link AgentModelCallProvider}: only the
 * provider HTTP hop is stubbed, so resolve → decrypt → auth-handle → SDK-call is real.
 */
describe('AI agent model call — real binding + credential resolution (ADR 0045)', () => {
  let app: INestApplication;
  let db: Client;
  /** Captures each stubbed provider request so the test can assert URL + injected credential. */
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];

  /** A stub `fetch` standing in for the provider: one text turn (no tool calls → final answer). */
  const stubFetch: FetchLike = (input, init) => {
    const url = String(input);
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ url, headers, body });
    const res: FetchLikeResponse = {
      status: 200,
      headers: { forEach: (cb) => cb('application/json', 'content-type') },
      // Anthropic Messages shape the SDK's anthropic agent adapter parses.
      text: () =>
        Promise.resolve(
          JSON.stringify({
            content: [{ type: 'text', text: 'hi from claude' }],
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
        ),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    return Promise.resolve(res);
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Only the wire hop is stubbed — the binding + credential resolution stay real.
      .overrideProvider(AGENT_MODEL_FETCH)
      .useValue(stubFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    await app.init();
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
  }, 30000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
  });

  it('binds AGENT_MODEL_CALL to the real AgentModelCallProvider in production DI', () => {
    expect(app.get(AGENT_MODEL_CALL)).toBeInstanceOf(AgentModelCallProvider);
    // The interpreter received that same real binding (not the unbound/stub seam).
    expect(app.get(AGENT_MODEL_CALL)).toBe(app.get(DagInterpreter)['agentModel']);
  });

  it('resolves a BYO connection credential and drives the SDK tool-aware generate', async () => {
    // A real user + a real encrypted BYO Anthropic key, stored through the connection system.
    await app.get(UserProvisioningService).getOrCreateMockUser();
    const conn = await app.get(ConnectionsService).createToken(MOCK_USER_ID, {
      provider: 'claude',
      credential: { api_key: 'sk-ant-e2e' },
      displayName: 'BYO Claude',
    });

    // An agent workflow whose model references that connection (compiler → auth:{connectionId}).
    const doc = {
      version: '1',
      name: 'agent-model-call',
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
          parameters: {
            model: { provider: 'claude', model: 'claude-opus-4-8' },
            system_prompt: 'You are helpful.',
            max_steps: 3,
            input: '{{trigger.chatInput}}',
            connectionId: conn.id,
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
    };

    const plan = compileWorkflowIrDag(doc);
    const result = await app
      .get(DagInterpreter)
      .run(plan, { externalUserId: MOCK_USER_ID, initialScope: { trigger: { chatInput: 'hello' } } });

    // The agent produced the model's answer + normalized usage — the loop drove the real primitive.
    const out = result.outputs.agent as AgentResult;
    expect(out.text).toBe('hi from claude');
    expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });

    // The opaque transport injected the DECRYPTED BYO key as `x-api-key` — never read by our code.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('api.anthropic.com');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-e2e');
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });
});
