import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { errors as joseErrors, SignJWT } from 'jose';

import {
  runApplyOps,
  runAskUser,
  runConnectionsStatus,
  runGetActionSchema,
  runListRuns,
  runNoteAssumption,
  runOfferSave,
  runPostBrief,
  runFillParams,
  runNeedConnection,
  runFindTrigger,
  runReadRun,
  runRunDraft,
  runTestStep,
  type ToolContext,
} from './agent-tools';
import {
  ComposerAuthGuard,
  callerSubOf,
  callerTokenOf,
  LOCAL_ISSUER,
  MOCK_USER_KEY,
  type TokenVerifyFn,
} from './composer-auth.guard';
import { PlatformKeysClient } from '../config/platform-keys.client';
import { ComposerService, QUERY_FN, type QueryFn } from './composer.service';
import { EventChannel } from './event-channel';
import { PendingAnswers } from './pending-answers';
import type { AttachEvent, ComposerEvent, SequencedComposerEvent } from './protocol';
import { emitToSession, SessionStore, type ComposerSession } from './sessions';
import { ThreadStore, type ThreadRecord } from './thread-store';
import { WorkflowServiceClient } from './workflow-client';

/**
 * The mapping is the risky part: SDK messages + tool-side emissions → the
 * sequenced protocol the canvas consumes, plus the attach/replay path and
 * the caller-auth guard. The SDK itself is scripted; the live loop is
 * exercised by the proof script (see README).
 */

const ENV = {
  environment: 'test',
  port: 8010,
  corsOriginList: ['http://localhost:3100'],
  workflowServiceUrl: 'http://localhost:8001',
  workflowServiceApiKey: 'ork_test',
  composerModel: 'claude-opus-4-8',
  paramModel: null,
  mockAuth: false,
  clerkIssuer: 'https://clerk.example',
  clerkAuthorizedParties: 'http://localhost:3100,http://localhost:3101',
  localSessionSecret: null as string | null,
};

function scriptedQuery(messages: Array<Record<string, unknown>>): QueryFn {
  const fn = (): AsyncGenerator<Record<string, unknown>> & { close: () => void } => {
    const gen = (async function* () {
      await Promise.resolve();
      for (const m of messages) yield m;
    })() as AsyncGenerator<Record<string, unknown>> & { close: () => void };
    gen.close = () => undefined;
    return gen;
  };
  return fn as unknown as QueryFn;
}

async function collect(events: AsyncGenerator<AttachEvent>): Promise<AttachEvent[]> {
  const out: AttachEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function makeService(
  queryFn: QueryFn,
  client: Partial<WorkflowServiceClient> = {},
  threads: ThreadStore = new ThreadStore(null), // default: persistence off — the memory-only baseline
): Promise<{ service: ComposerService; sessions: SessionStore; answers: PendingAnswers }> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ComposerService,
      SessionStore,
      PendingAnswers,
      { provide: ConfigService, useValue: { get: () => ENV } },
      { provide: WorkflowServiceClient, useValue: client },
      { provide: ThreadStore, useValue: threads },
      { provide: QUERY_FN, useValue: queryFn },
      // The key comes from workflow-service's store now, not this process's env.
      { provide: PlatformKeysClient, useValue: { anthropicApiKey: () => Promise.resolve('sk-test') } },
    ],
  }).compile();
  return {
    service: moduleRef.get(ComposerService),
    sessions: moduleRef.get(SessionStore),
    answers: moduleRef.get(PendingAnswers),
  };
}

/** A scripted ThreadStore double — enabled, with every DB call observable. */
function fakeThreads(thread: Partial<ThreadRecord> = {}): ThreadStore & {
  resolve: jest.Mock;
  append: jest.Mock;
  recordSdkSession: jest.Mock;
  rekey: jest.Mock;
  loadEvents: jest.Mock;
  transcriptExists: jest.Mock;
} {
  const record: ThreadRecord = {
    id: 'thread-1',
    userKey: 'user_1',
    workflowId: null,
    sdkSessionId: null,
    lastSeq: 0,
    ...thread,
  };
  return {
    enabled: true,
    resolve: jest.fn().mockResolvedValue(record),
    append: jest.fn(),
    recordSdkSession: jest.fn(),
    rekey: jest.fn().mockResolvedValue(undefined),
    loadEvents: jest.fn().mockResolvedValue([]),
    transcriptExists: jest.fn().mockReturnValue(false),
  } as unknown as ThreadStore & {
    resolve: jest.Mock;
    append: jest.Mock;
    recordSdkSession: jest.Mock;
    rekey: jest.Mock;
    loadEvents: jest.Mock;
    transcriptExists: jest.Mock;
  };
}

const never = new AbortController().signal;

/** A full session + emit-capturing ToolContext for direct handler tests. */
function makeCtx(
  client: Partial<WorkflowServiceClient> = {},
  draftNodes: Array<Record<string, unknown>> = [],
): {
  context: ToolContext;
  emitted: ComposerEvent[];
  answers: PendingAnswers;
  session: ComposerSession;
} {
  const session: ComposerSession = {
    id: crypto.randomUUID(),
    sdkSessionId: null,
    workflowId: null,
    threadId: null,
    userKey: null,
    callerOrgId: null,
    persist: null,
    draftIr: { nodes: draftNodes, edges: [] },
    busy: true,
    lastUsedAt: Date.now(),
    seq: 0,
    buffer: [],
    subscriber: null,
    callerToken: 'caller-jwt',
    turnAbort: null,
    orphanTimer: null,
    snapshot: {
      brief: null,
      questions: new Map(),
      assumptions: [],
      stepResults: new Map(),
      connectionNeeds: new Map(),
      ir: null,
      offerPending: false,
    },
    fixAttempts: new Map(),
    lastFailedNodeId: null,
  };
  const emitted: ComposerEvent[] = [];
  const answers = new PendingAnswers();
  const context: ToolContext = {
    session,
    answers,
    client: client as WorkflowServiceClient,
    emit: (event) => {
      emitted.push(event);
      emitToSession(session, event);
    },
    paramCompleter: null,
  };
  return { context, emitted, answers, session };
}

describe('ComposerService.stream', () => {
  it('maps a scripted SDK turn to session → sequenced assistant_text deltas → done', async () => {
    const { service } = await makeService(
      scriptedQuery([
        { type: 'system', subtype: 'init', session_id: 'sdk-123' },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } },
        },
        { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01 },
      ]),
    );

    const events = await collect(service.stream({ message: 'build it' }, never, 'jwt-1', null));
    expect(events[0]!.event).toBe('session');
    expect(events.slice(1, 3).map((e) => ({ event: e.event, data: e.data }))).toEqual([
      { event: 'assistant_text', data: { text: 'Hello ' } },
      { event: 'assistant_text', data: { text: 'there' } },
    ]);
    // Sequenced, strictly increasing (the replay key).
    const seqs = events.slice(1).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect((done.data as { num_turns?: number }).num_turns).toBe(2);
  });

  it('inserts a paragraph break between text blocks, but not before the first', async () => {
    const { service } = await makeService(
      scriptedQuery([
        { type: 'system', subtype: 'init', session_id: 's' },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First.' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Second.' } },
        },
        { type: 'result', subtype: 'success' },
      ]),
    );
    const events = await collect(service.stream({ message: 'x' }, never, null, null));
    const texts = events.filter((e) => e.event === 'assistant_text').map((e) => e.data.text);
    expect(texts).toEqual(['First.', '\n\n', 'Second.']);
  });

  it('captures the SDK session id, resumes with it, and passes a minimal subprocess env', async () => {
    const seenOptions: Array<Record<string, unknown>> = [];
    const base = scriptedQuery([
      { type: 'system', subtype: 'init', session_id: 'sdk-abc' },
      { type: 'result', subtype: 'success' },
    ]);
    const spying: QueryFn = ((args: { options?: Record<string, unknown> }) => {
      seenOptions.push(args.options ?? {});
      return (base as unknown as (a: unknown) => unknown)(args);
    }) as unknown as QueryFn;

    const { service } = await makeService(spying);
    const first = await collect(service.stream({ message: 'one' }, never, null, null));
    const sessionId = (first[0]!.data as { session_id: string }).session_id;
    await collect(service.stream({ message: 'two', session_id: sessionId }, never, null, null));

    expect(seenOptions[0]!.resume).toBeUndefined();
    expect(seenOptions[1]!.resume).toBe('sdk-abc');
    expect(seenOptions[0]!.tools).toEqual([]);
    expect(seenOptions[0]!.allowedTools).toEqual([
      'mcp__composer__search_catalog',
      'mcp__composer__read_workflow',
      'mcp__composer__get_action_schema',
      'mcp__composer__apply_ops',
      'mcp__composer__post_brief',
      'mcp__composer__ask_user',
      'mcp__composer__note_assumption',
      'mcp__composer__test_step',
      'mcp__composer__get_samples',
      'mcp__composer__run_draft',
      'mcp__composer__read_run',
      'mcp__composer__list_runs',
      'mcp__composer__connections_status',
      'mcp__composer__offer_save',
      'mcp__composer__find_trigger',
      'mcp__composer__need_connection',
      'mcp__composer__fill_params',
    ]);
    const subprocessEnv = seenOptions[0]!.env as Record<string, string | undefined>;
    expect(Object.keys(subprocessEnv).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'HOME',
      'MCP_TIMEOUT',
      'MCP_TOOL_TIMEOUT',
      'PATH',
      'TMPDIR',
    ]);
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('stores the freshest caller token on the session (tool calls run AS the user)', async () => {
    const { service, sessions } = await makeService(scriptedQuery([{ type: 'result', subtype: 'success' }]));
    const first = await collect(service.stream({ message: 'a' }, never, 'jwt-old', null));
    const id = (first[0]!.data as { session_id: string }).session_id;
    expect(sessions.get(id)!.callerToken).toBe('jwt-old');
    await collect(service.stream({ message: 'b', session_id: id }, never, 'jwt-new', null));
    expect(sessions.get(id)!.callerToken).toBe('jwt-new');
    // answerQuestion refreshes it too (long pauses outlive Clerk tokens).
    const { questionId } = (await makeService(scriptedQuery([]))).answers.create(id, 1000);
    void questionId;
    service.answerQuestion(id, crypto.randomUUID(), 'x', 'jwt-answer');
    expect(sessions.get(id)!.callerToken).toBe('jwt-answer');
  });

  it('a throwing SDK stream yields error + done, and the session is reusable after', async () => {
    const failing: QueryFn = (() => {
      const gen = (async function* () {
        await Promise.resolve();
        yield { type: 'system', subtype: 'init', session_id: 's' };
        throw new Error('subprocess died');
      })() as unknown as AsyncGenerator<Record<string, unknown>> & { close: () => void };
      gen.close = () => undefined;
      return gen;
    }) as unknown as QueryFn;

    const { service, sessions } = await makeService(failing);
    const events = await collect(service.stream({ message: 'x' }, never, null, null));
    expect(events.map((e) => e.event)).toEqual(['session', 'error', 'done']);
    const sessionId = (events[0]!.data as { session_id: string }).session_id;
    expect(sessions.get(sessionId)!.busy).toBe(false);
  });

  it('rejects an unknown session and a busy session with error events', async () => {
    const { service, sessions } = await makeService(scriptedQuery([{ type: 'result', subtype: 'success' }]));
    const unknown = await collect(
      service.stream({ message: 'x', session_id: crypto.randomUUID() }, never, null, null),
    );
    expect(unknown[0]!.event).toBe('error');

    const s = sessions.create(null, null);
    s.busy = true;
    const busy = await collect(service.stream({ message: 'x', session_id: s.id }, never, null, null));
    expect(busy[0]!.event).toBe('error');
  });

  it('refreshes the session draft from the message ir (user edits between turns win)', async () => {
    const { service, sessions } = await makeService(scriptedQuery([{ type: 'result', subtype: 'success' }]));
    const first = await collect(
      service.stream({ message: 'a', ir: { nodes: [], edges: [] } }, never, null, null),
    );
    const id = (first[0]!.data as { session_id: string }).session_id;
    const edited = { nodes: [{ id: 'n1' }], edges: [] };
    await collect(service.stream({ message: 'b', session_id: id, ir: edited }, never, null, null));
    expect(sessions.get(id)!.draftIr).toEqual(edited);
  });
});

describe('ComposerService.attach (refresh replay)', () => {
  it('gap-free lastSeq → tail replay; fresh attach (lastSeq 0) → ONE snapshot instead', async () => {
    const { service, sessions } = await makeService(scriptedQuery([]));
    const session = sessions.create(null, null);
    emitToSession(session, { event: 'assistant_text', data: { text: 'one' } }); // seq 1
    emitToSession(session, {
      event: 'brief',
      data: { name: 'n', goal: 'g', trigger: 't', steps: ['s'], needs: [] },
    }); // 2
    emitToSession(session, { event: 'done', data: { session_id: session.id, duration_ms: 1 } }); // 3

    // Fresh page: state snapshot, not history.
    const fresh = await collect(service.attach({ sessionId: session.id, lastSeq: 0 }, never));
    expect(fresh.map((e) => e.event)).toEqual(['session', 'snapshot']);
    const snap = fresh[1]!.data as { brief: { goal: string } | null; busy: boolean };
    expect(snap.brief?.goal).toBe('g');
    expect(snap.busy).toBe(false);

    // Brief blip with a still-buffered seq: just the missed tail.
    const partial = await collect(service.attach({ sessionId: session.id, lastSeq: 2 }, never));
    expect(partial.map((e) => e.event)).toEqual(['session', 'done']);
    expect(partial[1]!.seq).toBe(3);
  });

  it('the ring buffer rolling past lastSeq forces the snapshot path (long sessions reattach correctly)', async () => {
    const { service, sessions } = await makeService(scriptedQuery([]));
    const session = sessions.create(null, null);
    // Simulate a rolled buffer: events 1..3 fell off, only seq 4+ remain.
    emitToSession(session, { event: 'assistant_text', data: { text: 'old' } });
    emitToSession(session, {
      event: 'question',
      data: { question_id: 'q9', question: 'Which?', options: ['a', 'b'] },
    });
    session.buffer.splice(0, 1); // seq 1 gone
    emitToSession(session, { event: 'done', data: { session_id: session.id, duration_ms: 1 } });

    const events = await collect(service.attach({ sessionId: session.id, lastSeq: 1 }, never)); // lastSeq 1 < oldest buffered - 1? oldest=2 → gapFree… use 0-style gap
    // lastSeq 1 with oldest buffered seq 2 is still gap-free; force the gap:
    session.buffer.splice(0, 1); // seq 2 gone too — only seq 3 remains
    const gapped = await collect(service.attach({ sessionId: session.id, lastSeq: 1 }, never));
    expect(gapped.map((e) => e.event)).toEqual(['session', 'snapshot']);
    const snap = gapped[1]!.data as { questions: Array<{ question_id: string }> };
    expect(snap.questions.map((q) => q.question_id)).toContain('q9');
    void events;
  });

  it('continues a LIVE turn after replay (unanswered question chips re-render, then resolve)', async () => {
    const { service, sessions } = await makeService(scriptedQuery([]));
    const session = sessions.create(null, null);
    session.busy = true; // a paused turn is live server-side
    emitToSession(session, {
      event: 'question',
      data: { question_id: 'q1', question: 'Which channel?', options: ['#a', '#b'] },
    });

    const received: AttachEvent[] = [];
    const consumer = (async () => {
      for await (const e of service.attach({ sessionId: session.id, lastSeq: 0 }, never)) {
        received.push(e);
        if (e.event === 'done') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    // The snapshot carries the pending question; the live turn then continues.
    emitToSession(session, { event: 'question_resolved', data: { question_id: 'q1', answer: '#a' } });
    emitToSession(session, { event: 'done', data: { session_id: session.id, duration_ms: 1 } });
    await consumer;

    expect(received.map((e) => e.event)).toEqual(['session', 'snapshot', 'question_resolved', 'done']);
    const snap = received[1]!.data as { questions: Array<{ question_id: string; answer?: string }> };
    expect(snap.questions[0]).toMatchObject({ question_id: 'q1' });
    expect(snap.questions[0]!.answer).toBeUndefined();
  });

  it('an attach REPLACES the previous consumer (refreshed tab wins) and unknown sessions error', async () => {
    const { service, sessions } = await makeService(scriptedQuery([]));
    const session = sessions.create(null, null);
    session.busy = true;
    const old = new EventChannel<SequencedComposerEvent>();
    session.subscriber = old;

    const consumer = collect(
      (async function* () {
        for await (const e of service.attach({ sessionId: session.id, lastSeq: 0 }, never)) {
          yield e;
          if (e.event === 'done') return;
        }
      })(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(old.push({ event: 'assistant_text', data: { text: 'x' }, seq: 999 })).toBe(false); // closed
    emitToSession(session, { event: 'done', data: { session_id: session.id, duration_ms: 1 } });
    await consumer;

    const unknown = await collect(service.attach({ sessionId: crypto.randomUUID(), lastSeq: 0 }, never));
    expect(unknown[0]!.event).toBe('error');
  });
});

describe('ComposerService orphan grace (disconnect ≠ abort)', () => {
  it('a dropped stream leaves the turn alive; a reattach receives its later events', async () => {
    let releaseTurn: () => void = () => undefined;
    const gated: QueryFn = (() => {
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-g' };
        await new Promise<void>((r) => {
          releaseTurn = r;
        });
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } },
        };
        yield { type: 'result', subtype: 'success' };
      })() as unknown as AsyncGenerator<Record<string, unknown>> & { close: () => void };
      gen.close = () => undefined;
      return gen;
    }) as unknown as QueryFn;

    const { service, sessions } = await makeService(gated);
    const gone = new AbortController();
    const received: string[] = [];
    const streamDone = (async () => {
      for await (const e of service.stream({ message: 'x' }, gone.signal, null, null)) {
        received.push(e.event);
      }
    })();
    await new Promise((r) => setTimeout(r, 30));

    // The tab disconnects mid-turn…
    gone.abort();
    await new Promise((r) => setTimeout(r, 30));
    const session = [
      ...(sessions as unknown as { sessions: Map<string, ComposerSession> }).sessions.values(),
    ][0]!;
    expect(session.busy).toBe(true); // turn survives (orphan grace, not instant abort)
    expect(session.turnAbort?.signal.aborted).toBeFalsy();

    // …and a refreshed tab reattaches and receives the rest of the turn.
    const attached = collect(service.attach({ sessionId: session.id, lastSeq: 0 }, never));
    await new Promise((r) => setTimeout(r, 30));
    releaseTurn();
    const events = await attached;
    await streamDone;
    expect(events.map((e) => e.event)).toContain('assistant_text');
    expect(events.at(-1)!.event).toBe('done');
    expect(session.busy).toBe(false);
  });
});

describe('tool handlers (workflow-service wrappers)', () => {
  it('runApplyOps: landed batch updates the draft, emits op_applied, forwards the caller token', async () => {
    const ir = { nodes: [{ id: 'trigger', node_type: 'orchestr:trigger' }], edges: [] };
    const applyOps = jest.fn().mockResolvedValue({ ok: true, ir });
    const { context, session, emitted } = makeCtx({ applyOps });
    const ops = [{ op: 'add_node', node: { id: 'trigger', node_type: 'orchestr:trigger' } }];

    const result = await runApplyOps(context, ops);
    expect(result.isError).toBeUndefined();
    expect(session.draftIr).toBe(ir);
    expect(emitted).toEqual([{ event: 'op_applied', data: { ops, ir } }]);
    expect(applyOps).toHaveBeenCalledWith(expect.anything(), ops, 'caller-jwt');
  });

  /**
   * The composer hears "#social" and must store the channel ID, or the editor's picker shows the
   * stored label beside the real option and a human cannot tell them apart.
   */
  it('runApplyOps: a dropdown LABEL the agent wrote is stored as the option value', async () => {
    const applyOps = jest.fn().mockResolvedValue({ ok: true, ir: { nodes: [], edges: [] } });
    const { context } = makeCtx({
      applyOps,
      getActionSchema: jest.fn().mockResolvedValue({
        type: 'slack.send_channel_message',
        parameters: { channel: { type: 'DROPDOWN' }, text: { type: 'LONG_TEXT' } },
      }),
      listConnections: jest
        .fn()
        .mockResolvedValue([{ id: 'conn-1', provider: 'slack', status: 'active', display_name: null }]),
      loadOptions: jest.fn().mockResolvedValue([{ label: '#social', value: 'C0BFN9NKRUH' }]),
    });

    const result = await runApplyOps(context, [
      {
        op: 'add_node',
        node: {
          id: 'post_story',
          node_type: 'slack.send_channel_message',
          parameters: { channel: '#social', text: 'hi' },
        },
      },
    ]);

    expect(result.isError).toBeUndefined();
    const [, sentOps] = applyOps.mock.calls[0] as [unknown, Array<Record<string, unknown>>];
    expect((sentOps[0]!.node as Record<string, unknown>).parameters).toEqual({
      channel: 'C0BFN9NKRUH',
      text: 'hi',
    });
    // The step's own account is absent, so the picker is loaded with the caller's Slack connection.
    expect(context.client.loadOptions).toHaveBeenCalledWith(
      'slack.send_channel_message',
      'channel',
      'conn-1',
      'caller-jwt',
    );
  });

  it('runApplyOps: rejection → isError with detail, draft untouched, nothing emitted', async () => {
    const { context, session, emitted } = makeCtx({
      applyOps: () =>
        Promise.resolve({ ok: false as const, detail: 'ops[0] add_node "x": unknown action type "nope"' }),
    });
    const before = session.draftIr;
    const result = await runApplyOps(context, [{ op: 'add_node' }]);
    expect(result.isError).toBe(true);
    expect(session.draftIr).toBe(before);
    expect(emitted).toEqual([]);
  });

  it('runTestStep: pass and fail both drop a bead; failure text reaches the agent un-errored', async () => {
    const testStep = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, outputs: { fetch: { status: 200 } } })
      .mockResolvedValueOnce({ ok: false, detail: 'Run x failed: Invalid URL' });
    const { context, emitted } = makeCtx({ testStep }, [
      { id: 'fetch', node_type: 'http.send_request', parameters: { url: 'x' } },
    ]);

    const pass = await runTestStep(context, 'fetch', { trigger: { amount: 1 } });
    expect(pass.isError).toBeUndefined();
    expect(pass.content[0]!.text).toContain('passed');
    expect(emitted[0]).toEqual({ event: 'step_result', data: { node_id: 'fetch', status: 'passed' } });
    expect(testStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fetch', node_type: 'http.send_request' }),
      { trigger: { amount: 1 } },
      'caller-jwt',
    );

    const fail = await runTestStep(context, 'fetch', {});
    expect(fail.isError).toBeUndefined(); // a failed TEST is information, not a broken tool
    expect(fail.content[0]!.text).toContain('Invalid URL');
    expect(emitted[1]!.event).toBe('step_result');
    expect((emitted[1]!.data as { status: string }).status).toBe('failed');

    const unknown = await runTestStep(context, 'ghost', {});
    expect(unknown.isError).toBe(true);
  });

  it('runRunDraft success: a passed bead per step + run_result passed', async () => {
    const runFromIr = jest
      .fn()
      .mockResolvedValue({ ok: true, outputs: { trigger: {}, check: {}, notify: {} } });
    const { context, emitted } = makeCtx({ runFromIr }, [{ id: 'check', node_type: 'orchestr:if' }]);

    const result = await runRunDraft(context, { amount: 700 });
    expect(result.content[0]!.text).toContain('ran clean');
    const beads = emitted.filter((e) => e.event === 'step_result');
    expect(beads.map((b) => (b.data as { node_id: string }).node_id).sort()).toEqual(['check', 'notify']);
    expect(beads.every((b) => (b.data as { status: string }).status === 'passed')).toBe(true);
    const run = emitted.find((e) => e.event === 'run_result')!;
    expect((run.data as { status: string }).status).toBe('passed');
    expect(runFromIr).toHaveBeenCalledWith(
      expect.objectContaining({ triggerPayload: { amount: 700 } }),
      'caller-jwt',
    );
  });

  it('runRunDraft failure: per-step beads from the record, failed_node_id on run_result', async () => {
    const { context, emitted } = makeCtx(
      {
        runFromIr: () => Promise.resolve({ ok: false as const, detail: 'Run r1 failed: Invalid URL' }),
        readRun: () =>
          Promise.resolve({
            run_id: 'r1',
            status: 'error',
            error: 'Invalid URL',
            steps: [
              { node_id: 'check', status: 'completed', error: null },
              { node_id: 'fetch', status: 'error', error: 'Invalid URL' },
            ],
          }),
      },
      [{ id: 'fetch', node_type: 'http.send_request' }],
    );

    const result = await runRunDraft(context, {});
    expect(result.content[0]!.text).toContain('Invalid URL');
    const beads = emitted.filter((e) => e.event === 'step_result');
    expect(beads.map((b) => b.data)).toEqual([
      { node_id: 'check', status: 'passed' },
      { node_id: 'fetch', status: 'failed', summary: 'Invalid URL' },
    ]);
    const run = emitted.find((e) => e.event === 'run_result')!;
    expect(run.data).toEqual({ status: 'failed', run_id: expect.any(String), failed_node_id: 'fetch' });
  });

  it('runReadRun formats the per-step record for the fix loop', async () => {
    const { context } = makeCtx({
      readRun: () =>
        Promise.resolve({
          run_id: 'r9',
          status: 'error',
          error: 'Run failed',
          steps: [{ node_id: 'fetch', status: 'error', error: 'ECONNREFUSED' }],
        }),
    });
    const result = await runReadRun(context, 'r9');
    expect(result.content[0]!.text).toContain('r9: error');
    expect(result.content[0]!.text).toContain('fetch: error — ECONNREFUSED');
  });
});

describe('A3 accept + evolve tools and bounds', () => {
  it('offer_save emits the offer event and marks the snapshot pending', () => {
    const { context, emitted, session } = makeCtx();
    const result = runOfferSave(context);
    expect(emitted[0]!.event).toBe('offer');
    expect(session.snapshot.offerPending).toBe(true);
    expect(result.content[0]!.text).toContain('end your turn');
  });

  it('one question at a time is CODE-enforced: a concurrent ask_user bounces', async () => {
    const { context, answers, session } = makeCtx();
    const first = runAskUser(context, { question: 'One?', options: ['a', 'b'] });
    await new Promise((r) => setImmediate(r));
    const second = await runAskUser(context, { question: 'Two?', options: ['c', 'd'] });
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain('already waiting for an answer');
    // Resolve the first so the turn isn't left hanging.
    const qid = [...session.snapshot.questions.keys()][0]!;
    answers.answer(session.id, qid, 'a');
    await first;
  });

  it('test_step refuses a third attempt on a twice-failed step (two-fix bound)', async () => {
    const testStep = jest.fn().mockResolvedValue({ ok: false, detail: 'still broken' });
    const { context } = makeCtx({ testStep }, [{ id: 'fetch', node_type: 'http.send_request' }]);
    const one = await runTestStep(context, 'fetch', {});
    expect(one.content[0]!.text).toContain('failed');
    const two = await runTestStep(context, 'fetch', {});
    expect(two.content[0]!.text).toContain('stop and tell them honestly');
    const three = await runTestStep(context, 'fetch', {});
    expect(three.isError).toBe(true);
    expect(three.content[0]!.text).toContain('stop here');
    expect(testStep).toHaveBeenCalledTimes(2); // the third never ran
  });

  it('run_draft refuses re-running a twice-failed node and clears on success', async () => {
    const { context, session } = makeCtx(
      {
        runFromIr: jest.fn().mockResolvedValue({ ok: false, detail: 'Run failed: boom' }),
        readRun: () =>
          Promise.resolve({
            run_id: 'r',
            status: 'error',
            error: 'boom',
            steps: [{ node_id: 'fetch', status: 'error', error: 'boom' }],
          }),
      },
      [{ id: 'fetch', node_type: 'http.send_request' }],
    );
    await runRunDraft(context, {});
    await runRunDraft(context, {});
    expect(session.fixAttempts.get('fetch')).toBe(2);
    const third = await runRunDraft(context, {});
    expect(third.isError).toBe(true);
    expect(third.content[0]!.text).toContain("don't run again");
  });

  it('list_runs formats workflow history; sessions without a workflow bounce', async () => {
    const { context, session } = makeCtx({
      listRuns: () =>
        Promise.resolve([
          { run_id: 'r2', status: 'error', error: 'Invalid URL', started_at: '2026-07-12T10:00:00Z' },
          { run_id: 'r1', status: 'completed', error: null, started_at: '2026-07-12T09:00:00Z' },
        ]),
    });
    const noWf = await runListRuns(context, 5);
    expect(noWf.isError).toBe(true);
    session.workflowId = 'wf-1';
    const result = await runListRuns(context, 5);
    expect(result.content[0]!.text).toContain('r2 · error');
    expect(result.content[0]!.text).toContain('Invalid URL');
  });

  it('connections_status lists providers read-only', async () => {
    const { context } = makeCtx({
      listConnections: () =>
        Promise.resolve([
          { id: 'conn-slack-1', provider: 'slack', status: 'active', display_name: null },
          { id: 'conn-sheets-1', provider: 'sheets', status: 'expired', display_name: 'Team sheet' },
        ]),
    });
    const result = await runConnectionsStatus(context);
    expect(result.content[0]!.text).toContain('slack: active');
    expect(result.content[0]!.text).toContain('sheets (Team sheet): expired');
  });
});

describe('A4 tools: find_trigger / need_connection / fill_params', () => {
  it('find_trigger returns matching app trigger types with the re-type instruction', async () => {
    const { context } = makeCtx({
      listTriggerCatalog: () =>
        Promise.resolve([
          { type: 'orchestr:webhook', name: 'Incoming webhook', description: '', parameters: {} },
          {
            type: 'gmail.new_email',
            name: 'New email',
            description: 'A new email arrives',
            parameters: { label: {} },
          },
        ]),
    });
    const result = await runFindTrigger(context, 'new email');
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('gmail.new_email');
    expect(result.content[0]!.text).toContain('parameters: label');
    // Steers the agent to re-type the canvas trigger node — no separate trigger tool.
    expect(result.content[0]!.text).toContain('update_node');
    expect(result.content[0]!.text).toContain('"node_id":"trigger"');
    // Native kinds are not app triggers — they're used directly, not surfaced here.
    expect(result.content[0]!.text).not.toContain('orchestr:webhook');
  });

  it('find_trigger with no match steers to the two native kinds', async () => {
    const { context } = makeCtx({
      listTriggerCatalog: () =>
        Promise.resolve([{ type: 'gmail.new_email', name: 'New email', description: '', parameters: {} }]),
    });
    const result = await runFindTrigger(context, 'quantum teleport');
    expect(result.content[0]!.text).toContain('orchestr:schedule');
    expect(result.content[0]!.text).toContain('orchestr:webhook');
  });

  it('need_connection pins the chip, folds into the snapshot, and clears on a green re-test', () => {
    const { context, emitted, session } = makeCtx({}, [
      { id: 'post_slack', node_type: 'slack.send_channel_message' },
    ]);
    const missing = runNeedConnection(context, {
      node_id: 'nope',
      provider: 'slack',
      provider_label: 'Slack',
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('post_slack');

    const result = runNeedConnection(context, {
      node_id: 'post_slack',
      provider: ' Slack ',
      provider_label: 'Slack',
    });
    expect(result.isError).toBeUndefined();
    expect(emitted).toContainEqual({
      event: 'connection_needed',
      data: { node_id: 'post_slack', provider: 'slack', provider_label: 'Slack' },
    });
    expect([...session.snapshot.connectionNeeds.keys()]).toEqual(['post_slack']);

    // A green re-test on that step clears the standing ask from the snapshot.
    emitToSession(session, { event: 'step_result', data: { node_id: 'post_slack', status: 'passed' } });
    expect(session.snapshot.connectionNeeds.size).toBe(0);
  });

  it('fill_params is a hard error when PARAM_MODEL is unset and for control steps', async () => {
    const { context } = makeCtx({}, [{ id: 'check', node_type: 'orchestr:if' }]);
    const disabled = await runFillParams(context, 'check', 'compare amounts');
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0]!.text).toContain('not enabled');

    const withCompleter = { ...context, paramCompleter: () => Promise.resolve('{}') };
    const control = await runFillParams(withCompleter, 'check', 'compare amounts');
    expect(control.isError).toBe(true);
    expect(control.content[0]!.text).toContain('control step');
  });

  it('fill_params fills from the real schema, applies via apply_ops, and updates the canvas', async () => {
    const applyOps = jest.fn().mockResolvedValue({
      ok: true,
      ir: { nodes: [{ id: 'post_slack', node_type: 'slack.send_channel_message' }], edges: [] },
    });
    const { context, emitted } = makeCtx(
      {
        applyOps,
        getActionSchema: () =>
          Promise.resolve({
            type: 'slack.send_channel_message',
            name: 'Send message to channel',
            category: 'communication',
            description: '',
            auth: 'oauth2',
            parameters: {
              channel: { type: 'SHORT_TEXT', required: true },
              text: { type: 'LONG_TEXT', required: true },
            },
          }),
      },
      [{ id: 'post_slack', node_type: 'slack.send_channel_message', parameters: {} }],
    );
    const completer = jest
      .fn()
      .mockResolvedValue(
        '```json\n{"channel": "#expense-review", "text": "Expense: {{trigger.amount}}"}\n```',
      );
    const result = await runFillParams(
      { ...context, paramCompleter: completer },
      'post_slack',
      'announce the expense',
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('#expense-review');
    expect(applyOps.mock.calls[0]![1]).toEqual([
      {
        op: 'update_node',
        node_id: 'post_slack',
        parameters: { channel: '#expense-review', text: 'Expense: {{trigger.amount}}' },
      },
    ]);
    expect(emitted.some((e) => e.event === 'op_applied')).toBe(true);
  });

  it('fill_params surfaces validation failure after the bounded retry, canvas untouched', async () => {
    const applyOps = jest.fn();
    const { context } = makeCtx(
      {
        applyOps,
        getActionSchema: () =>
          Promise.resolve({
            type: 'slack.send_channel_message',
            name: 'Send message to channel',
            category: 'communication',
            description: '',
            auth: 'oauth2',
            parameters: { channel: { type: 'SHORT_TEXT', required: true } },
          }),
      },
      [{ id: 'post_slack', node_type: 'slack.send_channel_message' }],
    );
    const completer = jest.fn().mockResolvedValue('{"chanel": "#typo"}');
    const result = await runFillParams({ ...context, paramCompleter: completer }, 'post_slack', 'announce');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown parameter "chanel"');
    expect(completer).toHaveBeenCalledTimes(2); // the retry carried the rejection
    expect(completer.mock.calls[1]![1]).toContain('unknown parameter "chanel"');
    expect(applyOps).not.toHaveBeenCalled();
  });
});

describe('workflow binding adoption (composer-first new build)', () => {
  it('an unbound session adopts the first workflow_id it sees and never rebinds', async () => {
    const { service, sessions } = await makeService(scriptedQuery([{ type: 'result', subtype: 'success' }]), {
      readWorkflow: () => Promise.reject(new Error('not seeded in this test')),
    });
    const session = sessions.create(null, { nodes: [], edges: [] });
    await collect(service.stream({ message: 'x', session_id: session.id }, never, null, null));
    expect(session.workflowId).toBeNull();
    await collect(
      service.stream(
        { message: 'Saved and turned on.', session_id: session.id, workflow_id: 'wf-9' },
        never,
        null,
        null,
      ),
    );
    expect(session.workflowId).toBe('wf-9');
    await collect(
      service.stream({ message: 'y', session_id: session.id, workflow_id: 'wf-other' }, never, null, null),
    );
    expect(session.workflowId).toBe('wf-9');
  });
});

describe('ComposerService.refreshToken (long-turn rotation)', () => {
  it('updates the session token; unknown sessions 404 at the caller', async () => {
    const { service, sessions } = await makeService(scriptedQuery([]));
    expect(service.refreshToken(crypto.randomUUID(), 'jwt-x')).toBe(false);
    const session = sessions.create(null, null);
    expect(service.refreshToken(session.id, 'jwt-rotated')).toBe(true);
    expect(session.callerToken).toBe('jwt-rotated');
  });
});

describe('A1 conversation tools', () => {
  it('post_brief emits the card and tells the agent to wait when needs are open', () => {
    const { context, emitted } = makeCtx();
    const brief = {
      name: 'Big expenses → Slack',
      goal: 'Route big expenses to Slack',
      trigger: 'A form is submitted',
      steps: ['Check the amount'],
      needs: ['Which channel?'],
    };
    const waiting = runPostBrief(context, brief);
    // The card carries the name the workflow saves under — the client's default until it is renamed.
    expect(emitted).toEqual([{ event: 'brief', data: brief }]);
    expect((emitted[0]!.data as { name: string }).name).toBe('Big expenses → Slack');
    expect(waiting.content[0]!.text).toContain('END your turn');
    const ready = runPostBrief(context, { ...brief, needs: [] });
    expect(ready.content[0]!.text).toContain('go ahead and build');
  });

  it('ask_user pauses until the answer arrives, then resolves both surfaces', async () => {
    const { context, emitted, answers, session } = makeCtx();
    const turn = runAskUser(context, {
      question: 'Which channel should approvals go to?',
      options: ['#finance', '#general'],
      node_id: 'post_slack',
    });
    await new Promise((r) => setImmediate(r));
    const q = emitted[0]!;
    expect(q.event).toBe('question');
    const qid = (q.data as { question_id: string }).question_id;
    expect(answers.answer(session.id, qid, '#finance')).toBe(true);
    const result = await turn;
    expect(result.content[0]!.text).toContain('"#finance"');
    expect(emitted[1]).toEqual({
      event: 'question_resolved',
      data: { question_id: qid, answer: '#finance' },
    });
    expect(answers.answer(session.id, qid, '#general')).toBe(false);
  });

  it('ask_user timeout proceeds with the fallback and flags it for note_assumption', async () => {
    const { context, emitted } = makeCtx();
    const result = await runAskUser(
      context,
      { question: 'Which sheet?', options: ['New sheet', 'Existing'], fallback: 'New sheet' },
      20,
    );
    expect(result.content[0]!.text).toContain('note_assumption');
    const resolved = emitted.find((e) => e.event === 'question_resolved')!;
    expect((resolved.data as { timed_out?: boolean }).timed_out).toBe(true);
  });

  it('a turn ending cancels its pending questions; late answers 404 cleanly', async () => {
    const { context, answers, session } = makeCtx();
    const turn = runAskUser(context, { question: 'Which?', options: ['a', 'b'] });
    await new Promise((r) => setImmediate(r));
    answers.cancelForSession(session.id);
    const result = await turn;
    expect(result.isError).toBe(true);
    expect(answers.answer(session.id, 'anything', 'x')).toBe(false);
  });

  it('note_assumption badges an existing step and rejects unknown ids with the survivors', () => {
    const { context, emitted } = makeCtx({}, [{ id: 'post_slack', node_type: 'slack.send_channel_message' }]);
    const ok = runNoteAssumption(context, { node_id: 'post_slack', text: 'assumed: #general' });
    expect(ok.isError).toBeUndefined();
    expect(emitted).toEqual([
      { event: 'assumption', data: { node_id: 'post_slack', text: 'assumed: #general' } },
    ]);
    const bad = runNoteAssumption(context, { node_id: 'ghost', text: 'assumed: x' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('post_slack');
  });

  it('get_action_schema returns the FULL schema; unknown types bounce to search_catalog', async () => {
    const { context } = makeCtx({
      getActionSchema: (type: string) =>
        type === 'slack.send_channel_message'
          ? Promise.resolve({
              name: 'Send message to a channel',
              type,
              category: 'slack',
              description: 'Post a message.',
              auth: 'connection',
              parameters: { channel: { type: 'DROPDOWN', required: true } },
            })
          : Promise.resolve(null),
    });
    const full = await runGetActionSchema(context, 'slack.send_channel_message');
    expect(full.content[0]!.text).toContain('DROPDOWN');
    const unknown = await runGetActionSchema(context, 'slack.summon_dragon');
    expect(unknown.isError).toBe(true);
  });
});

describe('WorkflowServiceClient credentials', () => {
  function clientWith(env: typeof ENV): WorkflowServiceClient {
    const config = { get: () => env } as unknown as ConstructorParameters<typeof WorkflowServiceClient>[0];
    return new WorkflowServiceClient(config);
  }

  it('with real auth a null caller token FAILS — never escalates to the ork_ service key', async () => {
    const client = clientWith({ ...ENV, mockAuth: false });
    await expect(client.searchCatalog('slack', 5, null)).rejects.toThrow(/no credentials/);
  });

  it('under MOCK_AUTH the ork_ fallback is used', async () => {
    const client = clientWith({ ...ENV, mockAuth: true });
    const seen: Array<string | undefined> = [];
    const realFetch = global.fetch;
    global.fetch = ((url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers?.Authorization);
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    try {
      await client.searchCatalog('slack', 5, null);
    } finally {
      global.fetch = realFetch;
    }
    expect(seen).toEqual(['Bearer ork_test']);
  });
});

describe('ComposerAuthGuard', () => {
  function guardWith(verify: TokenVerifyFn, env = ENV): ComposerAuthGuard {
    const config = { get: () => env } as unknown as ConstructorParameters<typeof ComposerAuthGuard>[0];
    return new ComposerAuthGuard(config, verify);
  }
  function httpContext(authorization?: string): { ctx: ExecutionContext; req: Record<string, unknown> } {
    const req: Record<string, unknown> = { headers: authorization ? { authorization } : {} };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  it('MOCK_AUTH bypasses and attaches a null caller token + the shared mock user key', async () => {
    const { ctx, req } = httpContext();
    const guard = guardWith(() => Promise.reject(new Error('should not verify')), { ...ENV, mockAuth: true });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(callerTokenOf(req as never)).toBeNull();
    expect(callerSubOf(req as never)).toBe(MOCK_USER_KEY);
  });

  it('rejects a missing bearer and a bad token; attaches the raw token on success', async () => {
    const verify: TokenVerifyFn = (token) =>
      token === 'good'
        ? Promise.resolve({ sub: 'user_1', azp: 'http://localhost:3100' })
        : Promise.reject(new Error('nope'));
    const guard = guardWith(verify);

    await expect(guard.canActivate(httpContext().ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(httpContext('Bearer bad').ctx)).rejects.toThrow(UnauthorizedException);

    const { ctx, req } = httpContext('Bearer good');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(callerTokenOf(req as never)).toBe('good');
    expect(callerSubOf(req as never)).toBe('user_1'); // the durable thread key
  });

  it('rejects an azp outside the allow-list', async () => {
    const guard = guardWith(() => Promise.resolve({ sub: 'user_1', azp: 'http://evil.example' }));
    await expect(guard.canActivate(httpContext('Bearer t').ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('reports an expired Clerk token as expired, not merely invalid', async () => {
    const guard = guardWith(() => Promise.reject(new joseErrors.JWTExpired('exp', {})));
    await expect(guard.canActivate(httpContext('Bearer t').ctx)).rejects.toThrow(/Token expired/);
  });

  // Both paths configured at once (LOCAL_AUTH_ENABLED overriding the Clerk
  // default). Each pins its own issuer, so neither can accept the other's token.
  describe('with local sessions alongside Clerk', () => {
    const SECRET = 'shared-secret';
    const BOTH = { ...ENV, localSessionSecret: SECRET };

    const mint = (over: { secret?: string; issuer?: string } = {}): Promise<string> =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(over.issuer ?? LOCAL_ISSUER)
        .setSubject('user_local_1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(over.secret ?? SECRET));

    it('authenticates a local token without ever consulting the JWKS', async () => {
      let consulted = false;
      const guard = guardWith(() => {
        consulted = true;
        return Promise.reject(new Error('JWKS must not be reached for a local token'));
      }, BOTH);

      const { ctx, req } = httpContext(`Bearer ${await mint()}`);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(callerSubOf(req as never)).toBe('user_local_1');
      expect(consulted).toBe(false);
    });

    it('still falls through to Clerk for a Clerk token', async () => {
      const guard = guardWith(() => Promise.resolve({ sub: 'user_clerk_1' }), BOTH);

      const { ctx, req } = httpContext('Bearer clerk-token');
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(callerSubOf(req as never)).toBe('user_clerk_1');
    });

    it('refuses a local token once local auth is off, secret or not', async () => {
      // What a Clerk deployment derives: no second front door.
      const guard = guardWith(() => Promise.reject(new Error('not a Clerk token')), {
        ...ENV,
        localSessionSecret: null,
      });

      const ctx = httpContext(`Bearer ${await mint()}`).ctx;
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });
});

describe('durable threads (write-through + rehydrate)', () => {
  const turn = [
    { type: 'system', subtype: 'init', session_id: 'sdk-42' },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    },
    { type: 'result', subtype: 'success' },
  ];

  it('stream binds the (user, workflow) thread and write-throughs the transcript in order', async () => {
    const threads = fakeThreads({ id: 'thread-9', workflowId: 'wf-1' });
    const { service } = await makeService(scriptedQuery(turn), {}, threads);
    await collect(service.stream({ message: 'build it', workflow_id: 'wf-1' }, never, null, null, 'user_1'));

    expect(threads.resolve).toHaveBeenCalledWith('user_1', 'wf-1');
    const appended = threads.append.mock.calls.map((c) => c[1] as SequencedComposerEvent);
    expect(appended.map((e) => e.event)).toEqual(['user_message', 'assistant_text', 'done']);
    expect(appended[0]).toMatchObject({ data: { text: 'build it' }, seq: 1 });
    expect(appended.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(threads.append.mock.calls.every((c) => c[0] === 'thread-9')).toBe(true);
    expect(threads.recordSdkSession).toHaveBeenCalledWith('thread-9', 'sdk-42');
  });

  it('a pre-existing thread sets the seq floor — new events continue the durable log', async () => {
    const threads = fakeThreads({ id: 'thread-9', lastSeq: 7 });
    const { service } = await makeService(scriptedQuery(turn), {}, threads);
    await collect(service.stream({ message: 'more' }, never, null, null, 'user_1'));
    const appended = threads.append.mock.calls.map((c) => c[1] as SequencedComposerEvent);
    expect(appended[0]).toMatchObject({ event: 'user_message', seq: 8 });
  });

  it('the accept path re-keys the scratch thread to the created workflow', async () => {
    const threads = fakeThreads({ id: 'thread-scratch', workflowId: null });
    const { service } = await makeService(
      scriptedQuery([{ type: 'result', subtype: 'success' }]),
      {},
      threads,
    );
    const first = await collect(service.stream({ message: 'draft it' }, never, null, null, 'user_1'));
    const sessionId = (first[0]!.data as { session_id: string }).session_id;
    expect(threads.resolve).toHaveBeenCalledWith('user_1', null);

    await collect(
      service.stream(
        { message: 'Saved and turned on.', session_id: sessionId, workflow_id: 'wf-new' },
        never,
        null,
        'user_1',
      ),
    );
    expect(threads.rekey).toHaveBeenCalledWith('thread-scratch', 'wf-new');
  });

  it('attach by identity REHYDRATES from the event log — full replay from seq 1, live shapes', async () => {
    const log: SequencedComposerEvent[] = [
      { event: 'user_message', data: { text: 'build it' }, seq: 1 },
      { event: 'assistant_text', data: { text: 'On it.' }, seq: 2 },
      { event: 'brief', data: { name: 'n', goal: 'g', trigger: 't', steps: ['s'], needs: [] }, seq: 3 },
      { event: 'op_applied', data: { ops: [], ir: { nodes: [{ id: 'n1' }], edges: [] } }, seq: 4 },
      { event: 'done', data: { session_id: 'old-session', duration_ms: 5 }, seq: 5 },
    ];
    const threads = fakeThreads({ id: 'thread-9', workflowId: 'wf-1', lastSeq: 5 });
    threads.loadEvents.mockResolvedValue(log);
    const { service, sessions } = await makeService(scriptedQuery([]), {}, threads);

    // No in-memory session at all (restart/TTL) — identity is the only key.
    const events = await collect(service.attach({ workflowId: 'wf-1', lastSeq: 0 }, never, 'user_1'));
    expect(events[0]!.event).toBe('session');
    expect(events.slice(1)).toEqual(log); // the exact persisted transcript, in order
    expect(threads.loadEvents).toHaveBeenCalledWith('thread-9', 0);

    // The rebuilt session is indistinguishable from one that lived the events.
    const rebuilt = sessions.findByThread('thread-9')!;
    expect(rebuilt.seq).toBe(5);
    expect(rebuilt.draftIr).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
    expect(rebuilt.snapshot.brief?.goal).toBe('g');

    // A second identity attach reuses it — no duplicate session.
    const again = await collect(service.attach({ workflowId: 'wf-1', lastSeq: 0 }, never, 'user_1'));
    expect((again[0]!.data as { session_id: string }).session_id).toBe(rebuilt.id);
  });

  it('rehydration resumes the SDK session only while its transcript file survives', async () => {
    const withFile = fakeThreads({ id: 't1', workflowId: 'wf-1', sdkSessionId: 'sdk-old' });
    withFile.transcriptExists.mockReturnValue(true);
    const a = await makeService(scriptedQuery([]), {}, withFile);
    await collect(a.service.attach({ workflowId: 'wf-1', lastSeq: 0 }, never, 'user_1'));
    expect(a.sessions.findByThread('t1')!.sdkSessionId).toBe('sdk-old');

    const withoutFile = fakeThreads({ id: 't2', workflowId: 'wf-1', sdkSessionId: 'sdk-gone' });
    const b = await makeService(scriptedQuery([]), {}, withoutFile);
    await collect(b.service.attach({ workflowId: 'wf-1', lastSeq: 0 }, never, 'user_1'));
    expect(b.sessions.findByThread('t2')!.sdkSessionId).toBeNull(); // next turn starts fresh
  });

  it('attach on a live session replays the durable log plus the buffered tail the write-through has not landed', async () => {
    const threads = fakeThreads({ id: 'thread-9', workflowId: 'wf-1' });
    threads.loadEvents.mockResolvedValue([
      { event: 'user_message', data: { text: 'go' }, seq: 1 },
    ] as SequencedComposerEvent[]);
    const { service, sessions } = await makeService(scriptedQuery([]), {}, threads);
    const session = sessions.create('wf-1', null);
    session.threadId = 'thread-9';
    session.userKey = 'user_1';
    session.seq = 1;
    emitToSession(session, { event: 'assistant_text', data: { text: 'tail' } }); // seq 2, buffer only

    const events = await collect(service.attach({ sessionId: session.id, lastSeq: 0 }, never, 'user_1'));
    expect(events.map((e) => [e.event, e.seq])).toEqual([
      ['session', 2],
      ['user_message', 1],
      ['assistant_text', 2],
    ]);
  });

  it('DATABASE_URL unset → memory-only exactly as before: identity attach has nothing to replay', async () => {
    const { service } = await makeService(scriptedQuery([]));
    const events = await collect(service.attach({ workflowId: 'wf-1', lastSeq: 0 }, never, 'user_1'));
    expect(events).toEqual([
      { event: 'error', data: { message: 'Unknown or expired session — start a new one.' }, seq: 0 },
    ]);
  });

  it('a failing thread database is fail-soft: the stream still runs, memory-only', async () => {
    const threads = fakeThreads();
    threads.resolve.mockRejectedValue(new Error('connection refused'));
    const { service, sessions } = await makeService(scriptedQuery(turn), {}, threads);
    const events = await collect(service.stream({ message: 'x' }, never, null, null, 'user_1'));
    expect(events.map((e) => e.event)).toEqual(['session', 'assistant_text', 'done']);
    const sessionId = (events[0]!.data as { session_id: string }).session_id;
    expect(sessions.get(sessionId)!.threadId).toBeNull();
    expect(threads.append).not.toHaveBeenCalled();
  });

  it('user_message is transcript-only: buffered and persisted, never pushed to the live stream', async () => {
    const threads = fakeThreads();
    const { service } = await makeService(scriptedQuery(turn), {}, threads);
    const events = await collect(service.stream({ message: 'hello' }, never, null, null, 'user_1'));
    expect(events.some((e) => e.event === 'user_message')).toBe(false);
    const appended = threads.append.mock.calls.map((c) => (c[1] as SequencedComposerEvent).event);
    expect(appended).toContain('user_message');
  });
});

describe('EventChannel', () => {
  it('delivers pushes in order across buffered and awaited consumption, then closes', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    ch.push(2);
    const it = ch[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
    expect((await it.next()).value).toBe(2);
    const pending = it.next();
    ch.push(3);
    expect((await pending).value).toBe(3);
    ch.close();
    expect((await it.next()).done).toBe(true);
    expect(ch.push(4)).toBe(false);
  });
});
