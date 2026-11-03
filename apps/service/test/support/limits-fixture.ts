import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { irNode } from './golden-docs';
import { listenOnLoopback } from './listen';
import { ADMIN_URL, createE2eDatabase } from './test-db';

/** The user every request runs as under mock auth. */
export const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/** A loopback fixture that counts the requests on each path and holds those on a held path until it is released. */
export class HitFixture {
  private readonly hits = new Map<string, number>();
  private readonly holding = new Set<string>();
  private readonly held = new Map<string, ServerResponse[]>();
  private readonly server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    this.hits.set(path, this.count(path) + 1);
    if (this.holding.has(path)) {
      this.held.set(path, [...(this.held.get(path) ?? []), res]);
      return;
    }
    answer(res);
  });

  /** The fixture's address. */
  get base(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    this.releaseAll();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** How many requests reached `path`. */
  count(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  /** The requests on every path under `prefix`, summed. */
  countUnder(prefix: string): number {
    return [...this.hits].filter(([path]) => path.startsWith(prefix)).reduce((sum, [, n]) => sum + n, 0);
  }

  /** Hold every request on `path` until it is released. */
  hold(path: string): void {
    this.holding.add(path);
  }

  /** Answer every request held on `path`, and every later one at once. */
  release(path: string): void {
    this.holding.delete(path);
    for (const res of this.held.get(path) ?? []) answer(res);
    this.held.delete(path);
  }

  /** Answer every request held on any path, and stop holding. */
  releaseAll(): void {
    for (const path of [...this.holding, ...this.held.keys()]) this.release(path);
  }

  /** Resolves once `path` has had `n` requests. */
  async untilHit(path: string, n = 1): Promise<void> {
    for (let i = 0; i < 600 && this.count(path) < n; i++) await new Promise((r) => setTimeout(r, 25));
    if (this.count(path) < n) throw new Error(`${path} never had ${n} request(s)`);
  }

  reset(): void {
    this.hits.clear();
  }
}

function answer(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
}

/** A step that calls the fixture at `/<id>`. */
export const callStep = (base: string, id: string) =>
  irNode(id, 'http.send_request', { method: 'GET', url: `${base}/${id}` });

/** An IR edge on `port` of its source, `main` unless named. */
export const edgeOn = (from: string, to: string, port = 0, port_type = 'main') => ({
  id: `${from}->${to}:${port}:${port_type}`,
  source_node_id: from,
  source_port: port,
  target_node_id: to,
  target_port: 0,
  port_type,
});

/** Edges chaining `ids` in order. */
export const chain = (ids: string[]) => ids.slice(1).map((id, i) => edgeOn(ids[i]!, id));

/** A service booted in this process on a database of its own, with `env` set as its operator would. */
export interface LimitsApp {
  app: INestApplication;
  db: Client;
  close(): Promise<void>;
}

/** Boot the app in process (DBOS on, mock auth) with `env`, its providers overridden as `override` says. */
export async function bootLimitsApp(
  env: Record<string, string>,
  override: (
    builder: ReturnType<typeof Test.createTestingModule>,
  ) => ReturnType<typeof Test.createTestingModule> = (b) => b,
): Promise<LimitsApp> {
  const databaseUrl = await createE2eDatabase(ADMIN_URL);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const set = {
    DATABASE_URL: databaseUrl,
    PGBOSS_ENABLED: 'false',
    THROTTLE_LIMIT: '10000',
    MOCK_AUTH: 'true',
    DBOS_ENABLED: 'true',
    ...env,
  };
  Object.assign(process.env, set);
  delete process.env.DBOS_SYSTEM_DATABASE_URL;
  const moduleRef = await override(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
  configureApp(app);
  await app.init();
  await listenOnLoopback(app);
  return {
    app,
    db,
    close: async () => {
      await db.end();
      await app.close();
      for (const name of Object.keys(env)) delete process.env[name];
      process.env.DATABASE_URL = ADMIN_URL;
      process.env.MOCK_AUTH = 'false';
      process.env.DBOS_ENABLED = 'false';
    },
  };
}

/** A run's row by its client-facing id. */
export async function runRow(
  db: Client,
  runId: string,
): Promise<{ id: string; status: string; error: string | null; steps_used: number; limits: unknown }> {
  const { rows } = await db.query<{
    id: string;
    status: string;
    error: string | null;
    steps_used: number;
    limits: unknown;
  }>(`SELECT id, status, error, steps_used, limits FROM runtime_runs WHERE run_id = $1`, [runId]);
  if (!rows[0]) throw new Error(`no run ${runId}`);
  return rows[0];
}

/** Resolves once `read` holds, polling every 25 ms. */
export async function until(read: () => Promise<boolean>, what: string, tries = 800): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never saw ${what}`);
}
