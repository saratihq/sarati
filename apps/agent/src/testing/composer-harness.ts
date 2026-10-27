import { fork } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { decodeJwt } from 'jose';

import { SCRIPT_ROUTE } from './turn-script';

/** One server-sent event of a composer response. */
export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** How the stub answers one key read. */
export type KeyRead = (res: ServerResponse) => void;

/** Answers a key read as workflow-service does when the caller's key is `key`. */
export function answerKey(res: ServerResponse, key: string | null): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ api_key: key }));
}

/** workflow-service as a composer turn meets it: the key route, and the routes a scripted turn calls. */
export class ServiceStub {
  /** How many scripted turns have started. */
  started = 0;
  url = '';
  private readonly reads = new Map<string, number>();
  private readonly held: ServerResponse[] = [];
  private onHold: () => void = () => undefined;
  private readonly server = createServer((req, res) => this.answer(req, res));

  /** By sub, how a caller's second key read — the turn's, after the guard's — is answered; others get a key. */
  constructor(readonly turnRead = new Map<string, KeyRead>()) {}

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Resolves once a held scripted turn has parked. */
  parking(): Promise<void> {
    return new Promise((resolve) => (this.onHold = resolve));
  }

  /** Lets every parked turn go on. */
  release(): void {
    for (const res of this.held.splice(0)) res.end();
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === SCRIPT_ROUTE.release) {
      this.held.push(res);
      this.onHold();
    } else if (req.url === SCRIPT_ROUTE.started) {
      this.started += 1;
      res.writeHead(204).end();
    } else if (req.url === '/api/internal/platform-keys/anthropic') {
      const sub = decodeJwt((req.headers.authorization ?? '').slice('Bearer '.length)).sub ?? '';
      const read = (this.reads.get(sub) ?? 0) + 1;
      this.reads.set(sub, read);
      const answer = read === 2 ? this.turnRead.get(sub) : undefined;
      if (answer) answer(res);
      else answerKey(res, 'sk-test');
    } else {
      res.writeHead(404).end();
    }
  }
}

/** The agent's AppModule, booted by composer-process.ts in a process of its own, so a crash shows as one. */
export class AgentProcess {
  private constructor(
    readonly base: string,
    private readonly kill: () => void,
    private readonly exited: Promise<number | null>,
    private readonly log: () => string,
  ) {}

  static async start(env: Record<string, string>): Promise<AgentProcess> {
    let log = '';
    const child = fork(join(__dirname, 'composer-process.ts'), [], {
      cwd: join(__dirname, '..', '..'),
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: { PATH: process.env.PATH, ENVIRONMENT: 'development', LOG_LEVEL: 'warn', ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const base = await Promise.race([
      new Promise<string>((resolve) =>
        child.once('message', (message) => resolve((message as { url: string }).url)),
      ),
      exited.then((code) =>
        Promise.reject(new Error(`the agent exited as it booted (code ${code})\n${log}`)),
      ),
    ]);
    return new AgentProcess(
      base,
      () => child.kill(),
      exited,
      () => log,
    );
  }

  answering(): Promise<boolean> {
    return fetch(`${this.base}/api/health`).then(
      (res) => res.ok,
      () => false,
    );
  }

  /** Ends the process, failing with its log when it had already exited on its own. */
  async stop(): Promise<void> {
    // A refused probe means the process is gone, so its exit is certain and is waited for, never raced.
    const alive = await this.answering();
    this.kill();
    const code = await this.exited;
    if (!alive) throw new Error(`the agent exited (code ${code})\n${this.log().slice(-4_000)}`);
  }

  /** POSTs one composer message as the bearer of `token` and yields its events as they arrive. */
  async *turn(token: string, body: Record<string, unknown>): AsyncGenerator<SseEvent> {
    const res = await fetch(`${this.base}/api/composer/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200 || !res.body) throw new Error(`the stream answered ${res.status}`);
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
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
}

/** Every event left in a stream, and how it ended: complete, or cut off with the reason. */
export async function readToEnd(
  stream: AsyncGenerator<SseEvent>,
): Promise<{ events: SseEvent[]; end: string }> {
  const events: SseEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events, end: 'complete' };
  } catch (err) {
    return { events, end: `cut off: ${String(err)}` };
  }
}
