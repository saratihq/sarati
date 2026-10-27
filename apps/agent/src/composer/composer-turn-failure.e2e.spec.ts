import {
  AgentProcess,
  answerKey,
  readToEnd,
  ServiceStub,
  type KeyRead,
  type SseEvent,
} from '../testing/composer-harness';
import { mintLocalSession } from '../testing/local-session';
import { TURN_SCRIPT } from '../testing/turn-script';
import { DISABLED_MESSAGE } from './composer-availability.service';
import { providerFailureMessage } from './provider-failure';

const SECRET = 'shared-secret-off-the-data-volume';

// The turn's own key read — a caller's second, after the guard's — for each caller whose read fails.
const stub = new ServiceStub(
  new Map<string, KeyRead>([
    ['rate-limited', (res) => res.writeHead(429).end()],
    ['service-error', (res) => res.writeHead(500).end()],
    ['service-gone', (res) => res.socket?.destroy()],
    ['key-removed', (res) => answerKey(res, null)],
  ]),
);
let agent: AgentProcess | undefined;

async function* sse(sub: string, body: Record<string, unknown>): AsyncGenerator<SseEvent> {
  yield* agent!.turn(await mintLocalSession(SECRET, sub), body);
}

const opened = (): SseEvent => ({ event: 'session', data: { session_id: expect.any(String) } });
const said = (text: unknown): SseEvent => ({ event: 'assistant_text', data: { text } });
const failed = (message: string): SseEvent => ({ event: 'error', data: { message } });
const done = (): SseEvent => ({
  event: 'done',
  data: { session_id: expect.any(String), duration_ms: expect.any(Number) },
});
const finished = expect.objectContaining({ event: 'done' }) as SseEvent;

// Another caller's turn is parked mid-stream across `failing`, and has to finish once released.
async function besideALiveTurn(failing: () => Promise<void>): Promise<void> {
  const parked = stub.parking();
  const live = sse('steady', { message: TURN_SCRIPT.hold });
  expect((await live.next()).value).toMatchObject({ event: 'session' });
  expect((await live.next()).value).toEqual(said('holding'));
  await parked;

  await failing();

  expect(await agent!.answering()).toBe(true);
  stub.release();
  expect(await readToEnd(live)).toEqual({
    events: [said(expect.any(String)), finished],
    end: 'complete',
  });
}

beforeAll(() => stub.listen());

afterAll(() => stub.close());

beforeEach(async () => {
  agent = await AgentProcess.start({ SECRET_KEY: SECRET, WORKFLOW_SERVICE_URL: stub.url });
}, 60_000);

afterEach(async () => {
  stub.release();
  const running = agent;
  agent = undefined;
  await running?.stop();
});

describe('a composer turn that cannot start', () => {
  it.each([
    ['rate-limited', 'is turned away for asking too often', DISABLED_MESSAGE.rate_limited],
    ['service-error', 'meets a service error', DISABLED_MESSAGE.anthropic_api_key_missing],
    ['service-gone', 'cannot reach the service', DISABLED_MESSAGE.anthropic_api_key_missing],
    ['key-removed', 'finds the key gone', DISABLED_MESSAGE.anthropic_api_key_missing],
  ])(
    'ends with the reason when its key read %s %s, and the session takes the next message',
    async (sub, _how, message) => {
      await besideALiveTurn(async () => {
        const first = await readToEnd(sse(sub, { message: 'build me a workflow' }));
        expect(first).toEqual({ events: [opened(), failed(message), done()], end: 'complete' });

        const sessionId = first.events[0]!.data.session_id;
        const next = await readToEnd(sse(sub, { message: 'try again', session_id: sessionId }));
        expect(next.events.map((event) => event.event)).toEqual(['session', 'assistant_text', 'done']);
      });
    },
    20_000,
  );

  it('ends with an error when the Agent SDK cannot start', async () => {
    await besideALiveTurn(async () => {
      expect(await readToEnd(sse('sdk-refuses', { message: TURN_SCRIPT.refuse }))).toEqual({
        events: [opened(), failed(providerFailureMessage(null, '')), done()],
        end: 'complete',
      });
    });
  }, 20_000);
});

describe('a canvas holding steps the client sent malformed', () => {
  // The validation pipe drops keys naming an Object.prototype method, so String() still prints this id.
  const shadowing = { toString: 0, valueOf: 0 };

  it('reads a large one in the prompt rather than failing the turn', async () => {
    const ir = {
      nodes: [null, { id: 'n1', node_type: 'orchestr:code', pad: 'x'.repeat(30_500) }, { id: shadowing }],
      edges: [null],
    };
    await besideALiveTurn(async () => {
      expect(await readToEnd(sse('large-canvas', { message: 'hi', ir }))).toEqual({
        events: [
          opened(),
          said(
            expect.stringContaining(
              'Canvas now has 2 step(s): n1 (orchestr:code), [object Object] (undefined)\n',
            ),
          ),
          finished,
        ],
        end: 'complete',
      });
    });
  }, 20_000);

  it('lets the composer tools read it', async () => {
    const ir = { nodes: [null, { id: shadowing }, { id: 'n1', node_type: 'orchestr:code' }], edges: [null] };
    const answered = (result: Record<string, unknown>): SseEvent => said(JSON.stringify(result));
    await besideALiveTurn(async () => {
      expect(await readToEnd(sse('tool-reads', { message: TURN_SCRIPT.assume, ir }))).toEqual({
        events: [
          opened(),
          { event: 'assumption', data: { node_id: 'n1', text: 'assumed: #general' } },
          answered({ content: [{ type: 'text', text: 'Noted — the badge is on the step.' }] }),
          answered({
            content: [
              {
                type: 'text',
                text: 'note_assumption: no draft step with id "n2" — existing step ids: [object Object], n1. Add the step first.',
              },
            ],
            isError: true,
          }),
          said(expect.stringMatching(/assume$/)),
          finished,
        ],
        end: 'complete',
      });
    });
  }, 20_000);
});
