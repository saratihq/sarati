import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { decodeJwt, SignJWT } from 'jose';

import { TURN_SCRIPT } from '../testing/composer-process';
import { LOCAL_ISSUER } from './composer-auth.guard';
import { DISABLED_MESSAGE } from './composer-availability.service';
import { providerFailureMessage } from './provider-failure';

// The agent runs in a process of its own, so a crash shows as one rather than being inferred.

const SECRET = 'shared-secret-off-the-data-volume';

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

// The turn's own key read — a caller's second, after the guard's — for each caller whose read fails.
const TURN_READ: Record<string, (res: ServerResponse) => void> = {
  'rate-limited': (res) => res.writeHead(429).end(),
  'service-error': (res) => res.writeHead(500).end(),
  'service-gone': (res) => res.socket?.destroy(),
  'key-removed': (res) => answerKey(res, null),
};

const reads = new Map<string, number>();
const held: ServerResponse[] = [];
let parked: () => void = () => undefined;
let stub: Server;
let agent: { base: string; child: ChildProcess; exited: Promise<number | null>; log: () => string };

function answerKey(res: ServerResponse, key: string | null): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ api_key: key }));
}

async function startAgent(serviceUrl: string): Promise<typeof agent> {
  let log = '';
  const child = fork(join(__dirname, '..', 'testing', 'composer-process.ts'), [], {
    cwd: join(__dirname, '..', '..'),
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: {
      PATH: process.env.PATH,
      ENVIRONMENT: 'development',
      SECRET_KEY: SECRET,
      WORKFLOW_SERVICE_URL: serviceUrl,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const base = await Promise.race([
    new Promise<string>((resolve) =>
      child.once('message', (message) => resolve((message as { url: string }).url)),
    ),
    exited.then((code) => Promise.reject(new Error(`the agent exited as it booted (code ${code})\n${log}`))),
  ]);
  return { base, child, exited, log: () => log };
}

const answering = (): Promise<boolean> =>
  fetch(`${agent.base}/api/health`).then(
    (res) => res.ok,
    () => false,
  );

async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_ISSUER)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

async function* sse(sub: string, body: Record<string, unknown>): AsyncGenerator<SseEvent> {
  const res = await fetch(`${agent.base}/api/composer/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenFor(sub)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of res.body!) {
    pending += decoder.decode(chunk, { stream: true });
    for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
      const frame = pending.slice(0, end).split('\n');
      pending = pending.slice(end + 2);
      const field = (name: string): string =>
        frame.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
      yield { event: field('event'), data: JSON.parse(field('data')) as Record<string, unknown> };
    }
  }
}

async function readToEnd(stream: AsyncGenerator<SseEvent>): Promise<{ events: SseEvent[]; end: string }> {
  const events: SseEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events, end: 'complete' };
  } catch (err) {
    return { events, end: `cut off: ${String(err)}` };
  }
}

const opened = (): SseEvent => ({ event: 'session', data: { session_id: expect.any(String) } });
const failed = (message: string): SseEvent => ({ event: 'error', data: { message } });
const done = (): SseEvent => ({
  event: 'done',
  data: { session_id: expect.any(String), duration_ms: expect.any(Number) },
});

// Another caller's turn is parked mid-stream across `failing`, and has to finish once released.
async function besideALiveTurn(failing: () => Promise<void>): Promise<void> {
  const holding = new Promise<void>((resolve) => (parked = resolve));
  const live = sse('steady', { message: TURN_SCRIPT.hold });
  expect((await live.next()).value).toMatchObject({ event: 'session' });
  expect((await live.next()).value).toMatchObject({ event: 'assistant_text', data: { text: 'holding' } });
  await holding;

  await failing();

  expect(await answering()).toBe(true);
  for (const res of held.splice(0)) res.end();
  const after = await readToEnd(live);
  expect(after).toEqual({
    events: [
      expect.objectContaining({ event: 'assistant_text' }),
      expect.objectContaining({ event: 'done' }),
    ],
    end: 'complete',
  });
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    if (req.url === '/release') {
      held.push(res);
      parked();
      return;
    }
    if (req.url !== '/api/internal/platform-keys/anthropic') {
      res.writeHead(404).end();
      return;
    }
    const sub = decodeJwt((req.headers.authorization ?? '').slice('Bearer '.length)).sub ?? '';
    const read = (reads.get(sub) ?? 0) + 1;
    reads.set(sub, read);
    const failing = read === 2 ? TURN_READ[sub] : undefined;
    if (failing) failing(res);
    else answerKey(res, 'sk-test');
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  agent = await startAgent(`http://127.0.0.1:${(stub.address() as AddressInfo).port}`);
}, 60_000);

afterAll(async () => {
  agent.child.kill();
  await agent.exited;
  stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
});

// A refused probe means the process is gone, so its exit is certain and is waited for, never raced.
afterEach(async () => {
  if (await answering()) return;
  throw new Error(`the agent exited (code ${await agent.exited})\n${agent.log().slice(-4_000)}`);
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

  it('reads a large canvas holding a step that is not an object, rather than failing the turn', async () => {
    const ir = {
      nodes: [null, { id: 'n1', node_type: 'orchestr:code', pad: 'x'.repeat(30_500) }],
      edges: [null],
    };
    await besideALiveTurn(async () => {
      const turn = await readToEnd(sse('large-canvas', { message: 'hi', ir }));
      expect(turn).toEqual({
        events: [
          opened(),
          {
            event: 'assistant_text',
            data: { text: expect.stringContaining('Canvas now has 1 step(s): n1 (orchestr:code)\n') },
          },
          expect.objectContaining({ event: 'done' }),
        ],
        end: 'complete',
      });
    });
  }, 20_000);
});
