import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

/** This build's `apps/service`. */
export const THIS_SERVICE = join(__dirname, '..', '..');

/** A loopback port nothing listens on. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

const answering = (base: string): Promise<boolean> =>
  fetch(`${base}/api/health`).then(
    (res) => res.ok,
    () => false,
  );

/** A service in a process of its own. */
export interface ServiceProcess {
  /** Where it answers, `http://127.0.0.1:<port>`. */
  base: string;
  /** Everything it has written so far. */
  log(): string;
  /** Kill it with SIGKILL, as a crash would, and wait for it to be gone. */
  crash(): Promise<void>;
}

interface ServiceOptions {
  service: string;
  databaseUrl: string;
  earlier?: boolean;
  /** Boots through `test/golden/r0-boot.ts` with this model behind the agent node: one that calls a tool every turn. */
  model?: 'tool-every-turn';
  env?: Record<string, string>;
}

/**
 * Boot the `apps/service` at `service` on `databaseUrl`, DBOS on and mock auth, and wait for it to answer. An `earlier`
 * build boots through `test/golden/r0-boot.ts`, with a scripted model behind its agent node.
 */
export async function bootService(opts: ServiceOptions): Promise<ServiceProcess> {
  const service = await startService(opts);
  await service.answered;
  return service;
}

/** {@link bootService} without waiting: `answered` settles once it answers, or rejects if it never does. */
export async function startService(
  opts: ServiceOptions,
): Promise<ServiceProcess & { answered: Promise<void> }> {
  const port = await freePort();
  const entry = opts.earlier || opts.model ? join(__dirname, '..', 'golden', 'r0-boot.ts') : 'src/main.ts';
  let log = '';
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', entry], {
    cwd: opts.service,
    env: {
      ...process.env,
      GOLDEN_R0: opts.service,
      DATABASE_URL: opts.databaseUrl,
      DBOS_SYSTEM_DATABASE_URL: '',
      PORT: String(port),
      MOCK_AUTH: 'true',
      PGBOSS_ENABLED: 'false',
      DBOS_ENABLED: 'true',
      THROTTLE_LIMIT: '10000',
      ORCHESTR_HTTP_ALLOWED_HOSTS: '127.0.0.1',
      ...(opts.model ? { GOLDEN_MODEL: opts.model } : {}),
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
  const exited = new Promise((r) => child.once('exit', r));
  const service: ServiceProcess = {
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    crash: async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
  const answered = (async () => {
    for (let i = 0; i < 900; i++) {
      if (child.exitCode !== null) throw new Error(`the service exited as it booted\n${log.slice(-4_000)}`);
      if (await answering(service.base)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    await service.crash();
    throw new Error(`the service never answered\n${log.slice(-4_000)}`);
  })();
  answered.catch(() => undefined);
  return { ...service, answered };
}
