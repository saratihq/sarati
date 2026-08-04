import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AGENT_MODEL_CALL, type AgentStep } from '../src/runtime/agent';
import { AgentStepBus } from '../src/runtime/agent-step-bus';
import { ScriptedAgentModel } from '../src/runtime/agent.testkit';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/** A WEBHOOK-triggered agent (no chat trigger, so try-it chat can't reach it) with a tool and a reply step. */
function draftAgentDoc(): Record<string, unknown> {
  const node = (id: string, node_type: string, parameters: Record<string, unknown> = {}) => ({
    id,
    name: id,
    node_type,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  });
  const edge = (id: string, from: string, to: string, port_type: string) => ({
    id,
    source_node_id: from,
    source_port: 0,
    target_node_id: to,
    target_port: 0,
    port_type,
  });
  return {
    version: '1.0',
    name: 'agent test-run target',
    description: '',
    nodes: [
      node('hook', 'orchestr:webhook', {}),
      node('agent', 'orchestr:agent', {
        model: { provider: 'claude', model: 'claude-opus-4-8' },
        system_prompt: 'You are helpful.',
        max_steps: 5,
        input: '{{trigger.message}}',
      }),
      node('tool', 'text.concat', { tool_name: 'lookup', texts: ['tool-ran'], separator: '' }),
      node('reply', 'text.concat', { texts: ['reply=', '{{agent.text}}'], separator: '' }),
    ],
    edges: [
      edge('e-in', 'hook', 'agent', 'main'),
      edge('e-tool', 'agent', 'tool', 'tool'),
      edge('e-out', 'agent', 'reply', 'main'),
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  };
}

/** One parsed SSE frame — `event` defaults to `message`; `data` is the raw payload string; `id` is the SSE id (`''` if none). */
interface SseFrame {
  event: string;
  data: string;
  id: string;
}

/** Split an SSE text buffer into complete frames (`\n\n`-delimited), returning the leftover tail. */
function drainFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    let data = '';
    let id = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
      else if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
    }
    frames.push({ event, data, id });
  }
  return { frames, rest };
}

/** POST /api/runs/test-agent runs ONE agent node from a draft doc; DBOS is OFF so it resolves directly. */
describe('test-agent — single-agent test run (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let baseUrl = '';
  let model: ScriptedAgentModel;

  const userA = randomUUID();
  const keyA = 'ork_e2e_agenttest_aaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-agenttest@e2e.local', 'Owner AgentTest', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userA, hash(keyA), keyA.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.DBOS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    model = new ScriptedAgentModel([
      { text: 'thinking', toolCalls: [{ id: 'c1', name: 'lookup', input: {} }] },
      { text: 'here is your answer', toolCalls: [] },
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_MODEL_CALL)
      .useValue(model)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('runs the agent alone with its bound tools, streams steps under /draft, and applies the input override', async () => {
    const sessionId = randomUUID();
    const workflowId = randomUUID(); // streaming rendezvous only — no workflow row needed for a draft test

    // 1) SUBSCRIBE FIRST on the fixed `draft` env segment — same SSE side-channel as chat try-it.
    const sse = await fetch(`${baseUrl}/api/chat/${workflowId}/draft/events?session_id=${sessionId}`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sse.status).toBe(200);
    const steps: AgentStep[] = [];
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    const drain = (async () => {
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const out = drainFrames(buffer);
        buffer = out.rest;
        for (const frame of out.frames) {
          if (frame.event === 'message' && frame.data) steps.push(JSON.parse(frame.data) as AgentStep);
        }
      }
    })();

    // 2) THEN post with the SAME workflow/session ids. The task's literal `{{…}}` must reach the
    //    model verbatim, and the sample scope's stale agent output must be dropped, not collide.
    const res = await asA(
      http()
        .post('/api/runs/test-agent')
        .send({
          workflow_ir: draftAgentDoc(),
          node_id: 'agent',
          input: 'summarize the {{cost}} signups',
          sample_scope: { agent: { text: 'stale prior-run output' }, trigger: { message: 'unused' } },
          workflow_id: workflowId,
          session_id: sessionId,
        }),
    ).expect(201);

    // The agent ran to its final answer; the downstream `reply` step did NOT run.
    expect(res.body.outputs.agent.text).toBe('here is your answer');
    expect(res.body.outputs.reply).toBeUndefined();
    // The tool bound off the canvas edge really executed inside the loop.
    expect(res.body.outputs.agent.steps.map((s: AgentStep) => s.kind)).toEqual([
      'model',
      'tool',
      'model',
      'final',
    ]);
    expect(res.body.outputs.agent.steps[1].output).toBe('tool-ran');

    // The task overrode `{{trigger.message}}` as a LITERAL — the resolver would have thrown on `{{cost}}`.
    const firstUser = model.requests[0]!.messages.find((m) => m.role === 'user');
    expect(firstUser?.content).toBe('summarize the {{cost}} signups');

    // The live steps streamed to the draft-env channel, and the run closed it (no leak).
    await drain;
    expect(steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model', 'final']);
    expect(app.get(AgentStepBus).openSessionCount).toBe(0);
  }, 20_000);

  it('rejects a node that is not an agent (400) and an uncompilable document (400)', async () => {
    await asA(
      http().post('/api/runs/test-agent').send({ workflow_ir: draftAgentDoc(), node_id: 'reply' }),
    ).expect(400);
    await asA(
      http()
        .post('/api/runs/test-agent')
        .send({ workflow_ir: { nodes: [{ id: 'x', node_type: 'no.such_type' }] }, node_id: 'x' }),
    ).expect(400);
  });
});
