import { randomBytes } from 'node:crypto';

import { AgentProcess } from '../testing/composer-harness';

interface LogLine {
  level?: number;
  msg?: string;
  responseTime?: number;
  req?: { id?: string; method?: string; url?: string };
  res?: { statusCode?: number };
}

const INFO = 30;
const DEBUG = 20;

let atInfo: AgentProcess | undefined;
let atDebug: AgentProcess | undefined;

const linesOf = (agent: AgentProcess, id: string): LogLine[] =>
  agent
    .log()
    .split('\n')
    .filter((line) => line.startsWith('{"level":'))
    .map((line) => JSON.parse(line) as LogLine)
    .filter((line) => line.req?.id === id);

const requestId = (): string => `probe-e2e-${randomBytes(6).toString('hex')}`;

const send = (agent: AgentProcess, path: string, id: string, method = 'GET'): Promise<Response> =>
  fetch(`${agent.base}${path}`, { method, headers: { 'x-request-id': id } });

async function requestLine(agent: AgentProcess, id: string): Promise<LogLine> {
  for (let i = 0; i < 100; i++) {
    const line = linesOf(agent, id).find((logged) => logged.responseTime !== undefined);
    if (line) return line;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no request line for ${id}\n${agent.log().slice(-4_000)}`);
}

beforeAll(async () => {
  [atInfo, atDebug] = await Promise.all([
    AgentProcess.start({ LOG_LEVEL: 'info' }),
    AgentProcess.start({ LOG_LEVEL: 'debug' }),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all([atInfo?.stop(), atDebug?.stop()]);
});

describe('a passing health probe is logged only at debug, and every other request as before', () => {
  it('a probe answered 200 writes no line at info, while a HEAD to it and the request after it do', async () => {
    const probe = requestId();
    expect((await send(atInfo!, '/api/health', probe)).status).toBe(200);
    const queried = requestId();
    expect((await send(atInfo!, '/api/health?from=monitor', queried)).status).toBe(200);
    const head = requestId();
    expect((await send(atInfo!, '/api/health', head, 'HEAD')).status).toBe(200);
    const after = requestId();
    expect((await send(atInfo!, '/api/composer/status', after)).status).toBe(200);

    expect(await requestLine(atInfo!, head)).toMatchObject({
      level: INFO,
      msg: 'request completed',
      req: { method: 'HEAD', url: '/api/health' },
    });
    expect(await requestLine(atInfo!, after)).toMatchObject({
      level: INFO,
      msg: 'request completed',
      req: { method: 'GET', url: '/api/composer/status' },
      res: { statusCode: 200 },
    });
    expect([...linesOf(atInfo!, probe), ...linesOf(atInfo!, queried)]).toEqual([]);
  });

  it('at LOG_LEVEL=debug the same probe is a debug line', async () => {
    const probe = requestId();
    expect((await send(atDebug!, '/api/health', probe)).status).toBe(200);

    expect(await requestLine(atDebug!, probe)).toMatchObject({
      level: DEBUG,
      msg: 'request completed',
      req: { method: 'GET', url: '/api/health' },
      res: { statusCode: 200 },
    });
  });
});
