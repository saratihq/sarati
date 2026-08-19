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
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** A `chat → agent(one tool) → reply` workflow; `reply` is the unique terminal leaf, so its output is the chat reply. */
function agentChatDoc(): Record<string, unknown> {
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
    name: 'agent chat stream target',
    description: '',
    nodes: [
      node('chat', 'orchestr:chat', { greeting: 'Hi' }),
      node('agent', 'orchestr:agent', {
        model: { provider: 'claude', model: 'claude-opus-4-8' },
        system_prompt: 'You are helpful.',
        max_steps: 5,
        input: '{{trigger.chatInput}}',
      }),
      // The bound tool (peeled off the `tool` edge): a native no-auth action, aliased `lookup`.
      node('tool', 'text.concat', { tool_name: 'lookup', texts: ['tool-ran'], separator: '' }),
      node('reply', 'text.concat', { texts: ['reply=', '{{agent.text}}'], separator: '' }),
    ],
    edges: [
      edge('e-in', 'chat', 'agent', 'main'),
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

/** The live agent step-stream side-channel; DBOS is OFF so the chat intake runs the direct path. */
describe('agent step stream — SSE side-channel (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let baseUrl = '';

  const userA = randomUUID();
  const keyA = 'ork_e2e_agentstream_aaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-stream@e2e.local', 'Owner Stream', now(), now())`,
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Scripted model: one tool round then a final answer (no network, deterministic).
      .overrideProvider(AGENT_MODEL_CALL)
      .useValue(
        new ScriptedAgentModel([
          { text: 'thinking', toolCalls: [{ id: 'c1', name: 'lookup', input: {} }] },
          { text: 'here is your answer', toolCalls: [] },
        ]),
      )
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: agentChatDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;
    await app.get(TriggerReconcilerService).reconcile(wfId);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('streams the agent steps (model→tool→model→final) over SSE while the POST returns the final reply', async () => {
    const sessionId = randomUUID();
    // 1) SUBSCRIBE FIRST: `await fetch` resolves once the headers flush, i.e. once subscribed.
    const sse = await fetch(`${baseUrl}/api/chat/${wfId}/production/events?session_id=${sessionId}`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');

    // The reader ends only when the run closes the channel (bus.close in the chat intake).
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

    // 2) THEN POST with the SAME session_id — the run streams to the SSE above and replies here.
    const res = await http()
      .post(`/api/chat/${wfId}/production`)
      .send({ chatInput: 'go', sessionId })
      .expect(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.reply).toBe('reply=here is your answer');

    // The run ended → the intake closed the channel → the SSE stream ends. Await the drain.
    await drain;

    // The SSE received the recorded steps IN ORDER, contiguously indexed for client dedup.
    expect(steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model', 'final']);
    expect(steps.map((s) => s.step_index)).toEqual([0, 1, 2, 3]);
    expect(steps[1]!.tool).toBe('lookup');
    expect(steps[1]!.output).toBe('tool-ran');
    expect(steps[3]!.text).toBe('here is your answer');

    // CLEANUP: the session channel is gone once the run ended — no leak.
    expect(app.get(AgentStepBus).openSessionCount).toBe(0);
  }, 20_000);

  it('requires a session_id on the events stream', async () => {
    await http().get(`/api/chat/${wfId}/production/events`).expect(400);
  });
});

/** Two agent nodes, no tools — each loop invocation records model→final with `step_index` restarting at 0. */
function twoAgentChatDoc(): Record<string, unknown> {
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
  const agent = (id: string, input: string) =>
    node(id, 'orchestr:agent', {
      model: { provider: 'claude', model: 'claude-opus-4-8' },
      system_prompt: 'You are helpful.',
      max_steps: 5,
      input,
    });
  return {
    version: '1.0',
    name: 'two-agent chat stream target',
    description: '',
    nodes: [
      node('chat', 'orchestr:chat', { greeting: 'Hi' }),
      agent('agent1', '{{trigger.chatInput}}'),
      agent('agent2', '{{agent1.text}}'),
      node('reply', 'text.concat', { texts: ['reply=', '{{agent2.text}}'], separator: '' }),
    ],
    edges: [
      edge('e-in', 'chat', 'agent1', 'main'),
      edge('e-mid', 'agent1', 'agent2', 'main'),
      edge('e-out', 'agent2', 'reply', 'main'),
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  };
}

/** Drain an SSE Response body into `sink` (message frames only), returning the loop promise + a canceller. */
function collectSse(res: Response, sink: SseFrame[]): { done: Promise<void>; cancel: () => Promise<void> } {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let buffer = '';
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const out = drainFrames(buffer);
      buffer = out.rest;
      for (const frame of out.frames) if (frame.event === 'message' && frame.data) sink.push(frame);
    }
  })();
  return { done, cancel: () => reader.cancel() };
}

/**
 * The SSE `id` is a per-CHANNEL monotonic seq (never `step_index`), and the
 * channel is scoped by `workflow:env:session` so no subscriber can cross-read another's steps.
 */
describe('agent step stream — monotonic ids + tenant scoping (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let baseUrl = '';

  const userA = randomUUID();
  const keyA = 'ork_e2e_agentscope_bbbbbbbbbbbbbbbbbb';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner-scope@e2e.local', 'Owner Scope', now(), now())`,
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // One scripted turn: every agent-loop invocation answers immediately (model→final).
      .overrideProvider(AGENT_MODEL_CALL)
      .useValue(new ScriptedAgentModel([{ text: 'ok', toolCalls: [] }]))
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: twoAgentChatDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;
    await app.get(TriggerReconcilerService).reconcile(wfId);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('assigns strictly-monotonic SSE ids across two agent-loop invocations and drops no step', async () => {
    const sessionId = randomUUID();
    const sse = await fetch(`${baseUrl}/api/chat/${wfId}/production/events?session_id=${sessionId}`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sse.status).toBe(200);

    const frames: SseFrame[] = [];
    const drain = collectSse(sse, frames);

    const res = await http()
      .post(`/api/chat/${wfId}/production`)
      .send({ chatInput: 'go', sessionId })
      .expect(200);
    expect(res.body.reply).toBe('reply=ok');

    await drain.done; // the run closed the channel → the stream ended

    const steps = frames.map((f) => JSON.parse(f.data) as AgentStep);
    // Two invocations (agent1, agent2), each model→final = 4 steps total.
    expect(steps.map((s) => s.kind)).toEqual(['model', 'final', 'model', 'final']);
    // The PAYLOAD step_index restarts per invocation — the overlap the SSE id must survive.
    expect(steps.map((s) => s.step_index)).toEqual([0, 1, 0, 1]);
    // The SSE `id` is the session-unique monotonic seq — strictly increasing, no collision.
    const ids = frames.map((f) => Number(f.id));
    expect(ids).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);

    expect(app.get(AgentStepBus).openSessionCount).toBe(0);
  }, 20_000);

  it('does not leak steps to a subscriber on another workflow with the same session_id', async () => {
    const sessionId = randomUUID();
    const otherWfId = randomUUID(); // a different (tenant B) workflow — same session id

    // Subscriber B: another workflow's events endpoint, SAME session id. Must get NOTHING.
    const sseB = await fetch(`${baseUrl}/api/chat/${otherWfId}/production/events?session_id=${sessionId}`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sseB.status).toBe(200);
    const framesB: SseFrame[] = [];
    const drainB = collectSse(sseB, framesB);

    // Subscriber A: the firing workflow's events endpoint, same session id. Gets the steps.
    const sseA = await fetch(`${baseUrl}/api/chat/${wfId}/production/events?session_id=${sessionId}`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(sseA.status).toBe(200);
    const framesA: SseFrame[] = [];
    const drainA = collectSse(sseA, framesA);

    await http().post(`/api/chat/${wfId}/production`).send({ chatInput: 'go', sessionId }).expect(200);

    await drainA.done; // A's run closed A's channel → A's stream ended

    // A saw its 4 steps; B (different workflow, same session id) saw none — no cross-read.
    expect(framesA.map((f) => (JSON.parse(f.data) as AgentStep).kind)).toEqual([
      'model',
      'final',
      'model',
      'final',
    ]);
    expect(framesB).toEqual([]);

    await drainB.cancel(); // B's channel was never closed by the run — tear it down
  }, 20_000);
});
