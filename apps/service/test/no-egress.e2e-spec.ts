import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import type { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { request as undiciRequest } from 'undici';

import { OUTSIDE } from './support/egress-fixtures/dial';
import { takeRefusals } from './support/no-egress';
import { ADMIN_URL } from './support/test-db';

const SERVICE = join(__dirname, '..');
const FIXTURES = join(__dirname, 'support', 'egress-fixtures');

function refusalCode(err: unknown): unknown {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  while (e && e.code !== 'E2E_EGRESS_REFUSED' && e.cause) e = e.cause;
  return e?.code;
}

const failure = (emitter: EventEmitter): Promise<unknown> =>
  new Promise((resolve) => emitter.once('error', resolve));

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

// Answers `localhost` with an address outside the machine — the escape a name-only allowlist misses.
function lookupLocalhostOutside(
  hostname: string,
  options: dns.LookupOptions | number,
  callback: LookupCallback,
): void {
  if (hostname !== 'localhost') return dns.lookup(hostname, options as dns.LookupOptions, callback);
  if (typeof options === 'object' && options.all) return callback(null, [{ address: OUTSIDE, family: 4 }]);
  return callback(null, OUTSIDE, 4);
}

describe('e2e egress guard (in process)', () => {
  it.each([
    ['net', () => failure(net.connect({ host: OUTSIDE, port: 9 })), `${OUTSIDE}:9`],
    ['tls', () => failure(tls.connect({ host: OUTSIDE, port: 443 })), `${OUTSIDE}:443`],
    ['http', () => failure(http.get(`http://${OUTSIDE}/`)), `${OUTSIDE}:80`],
    ['https', () => failure(https.get(`https://${OUTSIDE}/`)), `${OUTSIDE}:443`],
    ['http2', () => failure(http2.connect(`http://${OUTSIDE}`)), `${OUTSIDE}:80`],
    ['fetch', () => fetch(`http://${OUTSIDE}/`).catch((e: unknown) => e), `${OUTSIDE}:80`],
    ['undici', () => undiciRequest(`http://${OUTSIDE}/`).catch((e: unknown) => e), `${OUTSIDE}:80`],
  ])('refuses %s to an outside address and charges it to the test', async (_, attempt, target) => {
    expect(refusalCode(await attempt())).toBe('E2E_EGRESS_REFUSED');
    expect(takeRefusals()).toEqual([target]);
  });

  it('refuses an outside name at the socket and at the system resolver', async () => {
    expect(refusalCode(await failure(net.connect({ host: 'example.invalid', port: 80 })))).toBe(
      'E2E_EGRESS_REFUSED',
    );
    await expect(dns.promises.lookup('example.invalid')).rejects.toMatchObject({
      code: 'E2E_EGRESS_REFUSED',
    });
    expect(takeRefusals()).toEqual(['example.invalid:80', 'example.invalid (DNS lookup)']);
  });

  it.each([
    ['dns.resolve4', () => promisify(dns.resolve4)('example.invalid')],
    ['dns.promises.resolve4', () => dns.promises.resolve4('example.invalid')],
    [
      'dns.Resolver',
      () => {
        const resolver = new dns.Resolver();
        return promisify(resolver.resolve4.bind(resolver))('example.invalid');
      },
    ],
    ['dns.promises.Resolver', () => new dns.promises.Resolver().resolve4('example.invalid')],
    ['dns.reverse', () => dns.promises.reverse(OUTSIDE)],
    ['dns.lookupService', () => dns.promises.lookupService(OUTSIDE, 53)],
  ])('refuses %s through the system resolver', async (_, query) => {
    await expect(query()).rejects.toMatchObject({ code: 'E2E_EGRESS_REFUSED' });
    expect(takeRefusals()).toHaveLength(1);
  });

  it('lets a resolver a test pointed at a loopback server query it', async () => {
    const resolver = new dns.promises.Resolver({ timeout: 200, tries: 1 });
    resolver.setServers(['127.0.0.1:9']);
    await expect(resolver.resolve4('example.invalid')).rejects.not.toMatchObject({
      code: 'E2E_EGRESS_REFUSED',
    });
    expect(takeRefusals()).toEqual([]);
  });

  it('checks what a local name resolves to, so a lookup answering localhost with an outside address is refused', async () => {
    const err = await failure(net.connect({ host: 'localhost', port: 9, lookup: lookupLocalhostOutside }));
    expect(refusalCode(err)).toBe('E2E_EGRESS_REFUSED');
    expect(takeRefusals()).toEqual([`localhost → ${OUTSIDE}`]);
  });

  it("refuses UDP to an outside address, including through a socket's own lookup", async () => {
    const send = (socket: dgram.Socket, host: string): Promise<unknown> =>
      new Promise((resolve) => socket.send('x', 9, host, (err) => (socket.close(), resolve(err))));
    expect(refusalCode(await send(dgram.createSocket('udp4'), OUTSIDE))).toBe('E2E_EGRESS_REFUSED');
    const ownLookup = dgram.createSocket({
      type: 'udp4',
      lookup: lookupLocalhostOutside as dgram.SocketOptions['lookup'],
    });
    expect(refusalCode(await send(ownLookup, 'localhost'))).toBe('E2E_EGRESS_REFUSED');
    expect(takeRefusals()).toEqual([`${OUTSIDE} (DNS lookup)`, `localhost → ${OUTSIDE}`]);
  });

  it.each([
    ['0.0.0.0', ['127.0.0.1']],
    ['::', ['127.0.0.1', '[::1]', 'localhost']],
  ])('lets a server bind %s, and loopback reach it', async (bind, hosts) => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, bind, resolve));
    const { port } = server.address() as AddressInfo;
    for (const host of hosts) {
      expect(await (await fetch(`http://${host}:${port}/`)).text()).toBe('ok');
    }
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    expect(takeRefusals()).toEqual([]);
  });

  it("lets the suite's own Postgres through", async () => {
    const db = new Client({ connectionString: ADMIN_URL });
    await db.connect();
    await db.query('SELECT 1');
    await db.end();
    expect(takeRefusals()).toEqual([]);
  });

  it('keeps dns.lookup promisifiable to its { address, family } shape', async () => {
    await expect(promisify(dns.lookup)('localhost')).resolves.toEqual({
      address: expect.any(String),
      family: expect.any(Number),
    });
  });
});

describe('e2e egress guard (reporting, through a nested jest run)', () => {
  const runFixtures = (files: string[], ...flags: string[]) =>
    spawnSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        ...files.map((file) => join(FIXTURES, file)),
        '--config',
        join(SERVICE, 'test', 'jest-e2e.json'),
        '--runTestsByPath',
        '--testRegex',
        '\\.egress-fixture\\.ts$',
        '--testSequencer',
        join(FIXTURES, 'in-path-order.sequencer.ts'),
        ...flags,
        '--testPathIgnorePatterns=/node_modules/',
      ],
      { cwd: SERVICE, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );

  it('fails the test that reached out, and the suite whose top-level hook did, though both swallowed the refusal', () => {
    const run = runFixtures(
      ['refused-in-a-test.egress-fixture.ts', 'refused-in-top-level-after-all.egress-fixture.ts'],
      '--json',
    );
    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout) as {
      testResults: Array<{
        name: string;
        status: string;
        message: string;
        assertionResults: Array<{ title: string; status: string; failureMessages: string[] }>;
      }>;
    };
    const suites = new Map(report.testResults.map((suite) => [basename(suite.name), suite]));

    const inTest = suites.get('refused-in-a-test.egress-fixture.ts')!;
    expect(inTest.assertionResults.map((t) => [t.title, t.status])).toEqual([
      ['swallows a refused dial', 'failed'],
      ['dials nothing', 'passed'],
    ]);
    expect(inTest.assertionResults[0]!.failureMessages.join('\n')).toContain(`reached for ${OUTSIDE}:9`);

    const inHook = suites.get('refused-in-top-level-after-all.egress-fixture.ts')!;
    expect(inHook.status).toBe('failed');
    expect(inHook.message).toContain(`reached for ${OUTSIDE}:9`);
  }, 120_000);

  it('fails the run, naming the suite, when a timer it leaked reaches out after it finished', () => {
    const run = runFixtures(['a-leaks-a-timer.egress-fixture.ts', 'b-outlives-the-leak.egress-fixture.ts']);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Tests:\s+2 passed, 2 total/);
    expect(run.stderr).toContain(
      `${OUTSIDE}:9 after test/support/egress-fixtures/a-leaks-a-timer.egress-fixture.ts finished`,
    );
  }, 120_000);
});
