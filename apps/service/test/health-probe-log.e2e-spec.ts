import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { DbLink } from './support/db-link';
import { bootService, pinoLines, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface LogLine {
  level?: number;
  msg?: string;
  responseTime?: number;
  req?: { id?: string; method?: string; url?: string };
  res?: { statusCode?: number };
}

const INFO = 30;
const DEBUG = 20;
const WARN = 40;

const linesOf = (service: ServiceProcess, id: string): LogLine[] =>
  pinoLines<LogLine>(service.log()).filter((line) => line.req?.id === id);

const requestId = (): string => `probe-e2e-${randomBytes(6).toString('hex')}`;

const send = (
  service: ServiceProcess,
  path: string,
  id: string,
  init: { method?: string; signal?: AbortSignal } = {},
): Promise<Response> => fetch(`${service.base}${path}`, { ...init, headers: { 'x-request-id': id } });

async function requestLine(service: ServiceProcess, id: string): Promise<LogLine> {
  for (let i = 0; i < 150; i++) {
    const line = linesOf(service, id).find((logged) => logged.responseTime !== undefined);
    if (line) return line;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no request line for ${id}\n${service.log().slice(-4_000)}`);
}

describe('a passing health probe is logged only at debug, and every other request as before (e2e, own process)', () => {
  let db: Client;
  let link: DbLink;
  let atInfo: ServiceProcess | undefined;
  let atDebug: ServiceProcess | undefined;

  beforeAll(async () => {
    const [quietDb, verboseDb] = await Promise.all([
      createE2eDatabase(ADMIN_URL),
      createE2eDatabase(ADMIN_URL),
    ]);
    db = new Client({ connectionString: quietDb });
    await db.connect();
    link = await DbLink.open(quietDb);
    [atInfo, atDebug] = await Promise.all([
      bootService({ service: THIS_SERVICE, databaseUrl: link.url, env: { LOG_LEVEL: 'info' } }),
      bootService({ service: THIS_SERVICE, databaseUrl: verboseDb, env: { LOG_LEVEL: 'debug' } }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([atInfo?.crash(), atDebug?.crash()]);
    await db.end();
    await link.close();
  }, 30_000);

  it('a probe answered 200 writes no line at info, while a HEAD to it and the request after it do', async () => {
    const probe = requestId();
    expect((await send(atInfo!, '/api/ready', probe)).status).toBe(200);
    const queried = requestId();
    expect((await send(atInfo!, '/api/ready?from=monitor', queried)).status).toBe(200);
    const head = requestId();
    expect((await send(atInfo!, '/api/ready', head, { method: 'HEAD' })).status).toBe(200);
    const after = requestId();
    expect((await send(atInfo!, '/api/health', after)).status).toBe(200);

    expect(await requestLine(atInfo!, head)).toMatchObject({
      level: INFO,
      msg: 'request completed',
      req: { method: 'HEAD', url: '/api/ready' },
    });
    expect(await requestLine(atInfo!, after)).toMatchObject({
      level: INFO,
      msg: 'request completed',
      req: { method: 'GET', url: '/api/health' },
      res: { statusCode: 200 },
    });
    expect([...linesOf(atInfo!, probe), ...linesOf(atInfo!, queried)]).toEqual([]);
  });

  it('at LOG_LEVEL=debug the same probe is a debug line', async () => {
    const probe = requestId();
    expect((await send(atDebug!, '/api/ready', probe)).status).toBe(200);

    expect(await requestLine(atDebug!, probe)).toMatchObject({
      level: DEBUG,
      msg: 'request completed',
      req: { method: 'GET', url: '/api/ready' },
      res: { statusCode: 200 },
    });
  });

  it('a probe its caller gives up on while the database check hangs is logged at info as aborted', async () => {
    const holding = link.holdNext('SELECT 1');
    const probe = requestId();
    const cut = new AbortController();
    const answer = send(atInfo!, '/api/ready', probe, { signal: cut.signal });
    const held = await holding;
    cut.abort();
    await expect(answer).rejects.toThrow('aborted');

    const line = await requestLine(atInfo!, probe);
    held.release();
    expect(line).toMatchObject({
      level: INFO,
      msg: 'request aborted',
      req: { method: 'GET', url: '/api/ready' },
    });
    expect((await send(atInfo!, '/api/ready', requestId())).status).toBe(200);
  });

  it('a probe whose database connection is lost answers 503 and is logged at info with the reason', async () => {
    const holding = link.holdNext('SELECT 1');
    const probe = requestId();
    const answer = send(atInfo!, '/api/ready', probe);
    const { pid } = await holding;
    expect((await db.query('SELECT pg_terminate_backend($1) AS ended', [pid])).rows).toEqual([
      { ended: true },
    ]);

    const res = await answer;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', database: false });
    expect(await requestLine(atInfo!, probe)).toMatchObject({
      level: INFO,
      msg: 'request errored',
      req: { method: 'GET', url: '/api/ready' },
      res: { statusCode: 503 },
    });
    expect(linesOf(atInfo!, probe).find((line) => line.level === WARN)?.msg).toBe(
      'Readiness DB check failed: terminating connection due to administrator command',
    );
    expect((await send(atInfo!, '/api/ready', requestId())).status).toBe(200);
  });
});
