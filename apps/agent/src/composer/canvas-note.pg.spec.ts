import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client, Pool } from 'pg';

import { ADMIN_URL, createE2eDatabase } from '../../../service/test/support/test-db';
import { PlatformKeysClient } from '../config/platform-keys.client';
import { ComposerService, QUERY_FN, type QueryFn } from './composer.service';
import { PendingAnswers } from './pending-answers';
import type { AttachEvent } from './protocol';
import { emitToSession, SessionStore } from './sessions';
import { ThreadStore } from './thread-store';
import { WorkflowServiceClient } from './workflow-client';

const ENV = { composerModel: 'claude-opus-4-8', paramModel: null };
const never = new AbortController().signal;
const NO_CALLER = { token: null };

const node = (id: string, name: string): Record<string, unknown> => ({ id, name, parameters: {} });
const trigger = node('trigger', 'Trigger');
const digest = node('build_digest', 'Build the digest');
const report = node('send_report', 'Email me the report');
const canvas = (...nodes: Array<Record<string, unknown>>): Record<string, unknown> => ({ nodes, edges: [] });

// One agent process: its own sessions in memory, the thread log in the shared database.
async function agentProcess(pool: Pool): Promise<{
  service: ComposerService;
  sessions: SessionStore;
  threads: ThreadStore;
  prompts: string[];
}> {
  const prompts: string[] = [];
  const query = ((params: { prompt: string }) => {
    prompts.push(params.prompt);
    const turn = (async function* () {
      await Promise.resolve();
      yield { type: 'result', subtype: 'success' };
    })() as AsyncGenerator<Record<string, unknown>> & { close: () => void };
    turn.close = () => undefined;
    return turn;
  }) as unknown as QueryFn;
  const threads = new ThreadStore(pool);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ComposerService,
      SessionStore,
      PendingAnswers,
      { provide: ConfigService, useValue: { get: () => ENV } },
      { provide: WorkflowServiceClient, useValue: {} },
      { provide: ThreadStore, useValue: threads },
      { provide: QUERY_FN, useValue: query },
      {
        provide: PlatformKeysClient,
        useValue: { readAnthropicKey: () => Promise.resolve({ key: 'sk-test', rateLimited: false }) },
      },
    ],
  }).compile();
  return { service: moduleRef.get(ComposerService), sessions: moduleRef.get(SessionStore), threads, prompts };
}

async function collect(events: AsyncGenerator<AttachEvent>): Promise<AttachEvent[]> {
  const out: AttachEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const sessionIdOf = (events: AttachEvent[]): string => (events[0]!.data as { session_id: string }).session_id;

// The composer's canvas note across an agent restart, against a real composer_thread_events log.
describe('the canvas note after a restart (e2e, throwaway Postgres database)', () => {
  let url: string;
  let pool: Pool;

  beforeAll(async () => {
    url = await createE2eDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: url });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(url).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  it('a rebuilt session judges by the last canvas and branch the log holds, as the live one did', async () => {
    const user = `user_${randomUUID()}`;
    const workflowId = randomUUID();
    await pool.query(`INSERT INTO workflows (id, name) VALUES ($1, 'Daily digest')`, [workflowId]);

    const before = await agentProcess(pool);
    const first = await collect(
      before.service.stream(
        { message: 'Email me a daily digest', ir: canvas(trigger), branch: 'main' },
        never,
        NO_CALLER,
        user,
      ),
    );
    const id = sessionIdOf(first);
    emitToSession(before.sessions.get(id)!, {
      event: 'op_applied',
      data: { ops: [], ir: canvas(trigger, digest, report) },
    });
    await collect(
      before.service.stream(
        {
          message: 'Created it.',
          session_id: id,
          workflow_id: workflowId,
          ir: canvas(trigger, digest),
          branch: 'main',
        },
        never,
        NO_CALLER,
        user,
      ),
    );
    expect(before.prompts.at(-1)).toContain(
      '<canvas_changes>Not on the canvas now: "Email me the report" (send_report).</canvas_changes>',
    );
    await before.threads.flush();

    // The first message after a restart is judged by the hand-off's canvas and branch, read back from the log.
    const after = await agentProcess(pool);
    const rebuilt = sessionIdOf(await collect(after.service.attach({ workflowId, lastSeq: 0 }, never, user)));
    expect(rebuilt).not.toBe(id);
    await collect(
      after.service.stream(
        { message: 'Simpler', session_id: rebuilt, ir: canvas(trigger), branch: 'main' },
        never,
        NO_CALLER,
        user,
      ),
    );
    expect(after.prompts.at(-1)).toContain(
      '<canvas_changes>Not on the canvas now: "Build the digest" (build_digest).</canvas_changes>',
    );
    await after.threads.flush();

    const restartedAgain = await agentProcess(pool);
    const again = sessionIdOf(
      await collect(restartedAgain.service.attach({ workflowId, lastSeq: 0 }, never, user)),
    );
    await collect(
      restartedAgain.service.stream(
        { message: 'On my branch', session_id: again, ir: canvas(), branch: 'older' },
        never,
        NO_CALLER,
        user,
      ),
    );
    expect(restartedAgain.prompts.at(-1)).not.toContain('<canvas_changes>');
  });

  describe('a message with no session id, as the editor resends one after "Unknown or expired session"', () => {
    const REPORT_GONE =
      '<canvas_changes>Not on the canvas now: "Email me the report" (send_report).</canvas_changes>';
    const EXPIRED = [
      { event: 'error', data: { message: 'Unknown or expired session — start a new one.' }, seq: 0 },
    ];

    // A build on main whose last draft holds the report step, written to the thread.
    async function built(): Promise<{
      agent: Awaited<ReturnType<typeof agentProcess>>;
      workflowId: string;
      user: string;
      id: string;
    }> {
      const user = `user_${randomUUID()}`;
      const workflowId = randomUUID();
      await pool.query(`INSERT INTO workflows (id, name) VALUES ($1, 'Daily digest')`, [workflowId]);
      const agent = await agentProcess(pool);
      const first = await collect(
        agent.service.stream(
          {
            message: 'Email me a daily digest',
            workflow_id: workflowId,
            ir: canvas(trigger),
            branch: 'main',
          },
          never,
          NO_CALLER,
          user,
        ),
      );
      const id = sessionIdOf(first);
      emitToSession(agent.sessions.get(id)!, {
        event: 'op_applied',
        data: { ops: [], ir: canvas(trigger, digest, report) },
      });
      await agent.threads.flush();
      return { agent, workflowId, user, id };
    }

    const resend = (
      agent: Awaited<ReturnType<typeof agentProcess>>,
      workflowId: string,
      user: string,
      sessionId?: string,
    ): Promise<AttachEvent[]> =>
      collect(
        agent.service.stream(
          {
            message: 'Add a filter',
            ...(sessionId ? { session_id: sessionId } : {}),
            workflow_id: workflowId,
            ir: canvas(trigger, digest),
            branch: 'main',
          },
          never,
          NO_CALLER,
          user,
        ),
      );

    it('after the session expired', async () => {
      const { agent, workflowId, user, id } = await built();
      agent.sessions.remove(id);

      expect(await resend(agent, workflowId, user, id)).toEqual(EXPIRED);
      await resend(agent, workflowId, user);
      expect(agent.prompts.at(-1)).toContain(REPORT_GONE);
    });

    it('after a restart', async () => {
      const { workflowId, user, id } = await built();
      const after = await agentProcess(pool);

      expect(await resend(after, workflowId, user, id)).toEqual(EXPIRED);
      await resend(after, workflowId, user);
      expect(after.prompts.at(-1)).toContain(REPORT_GONE);
    });
  });
});
