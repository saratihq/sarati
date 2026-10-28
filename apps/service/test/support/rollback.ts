import { execFile } from 'node:child_process';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { unpackBuild, type EarlierBuild } from './earlier-build';
import { bootService, THIS_SERVICE, type ServiceProcess } from './service-process';
import { ADMIN_URL, createE2eDatabase } from './test-db';

/** The user every request runs as under mock auth. */
export const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/** A run as `runtime_runs` keeps it. */
export interface RunRow {
  run_id: string;
  status: string;
  error: string | null;
  finished_at: Date | null;
  decided_by: string | null;
}

/** One suite's database, which this build and an earlier one boot on in turn, and a loopback fixture beside them. */
export interface RollbackSuite {
  /** Boot this build, or the earlier one, as the suite's service. */
  boot: (build: 'this' | 'earlier', env?: Record<string, string>) => Promise<ServiceProcess>;
  /** Run this build's or the earlier one's `db:migrate` on the database, as its image does before it starts, answering with what it printed. */
  migrate: (build: 'this' | 'earlier') => Promise<string>;
  /** The app database. */
  db: () => Client;
  /** The fixture's address for `path`. */
  fixtureUrl: (path: string) => string;
  /** POST `body` as JSON to `path` on the service booted last. */
  post: (path: string, body: unknown) => Promise<Response>;
  /** Read every 100ms until `done` holds, at most `tries` times, failing with `what` and the tail of the service's log. */
  eventually: <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
    tries?: number,
  ) => Promise<T>;
  /** Every run, by its run id. */
  runs: () => Promise<Record<string, RunRow>>;
  /** Every DBOS workflow's status, by the run id it runs. */
  workflows: () => Promise<Record<string, string>>;
}

/** A {@link RollbackSuite} going back to the build at `sha`, its fixture answering with `onRequest`. */
export function rollbackSuite(sha: string, onRequest: RequestListener): RollbackSuite {
  let earlier: EarlierBuild | undefined;
  let databaseUrl = '';
  let db: Client | undefined;
  let dbos: Client | undefined;
  let service: ServiceProcess | undefined;
  const fixture = createServer(onRequest);

  beforeAll(async () => {
    earlier = unpackBuild(sha);
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  }, 300_000);

  afterAll(async () => {
    await service?.crash();
    await dbos?.end();
    await db?.end();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
    earlier?.remove();
  }, 60_000);

  const eventually = async <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
    tries = 300,
  ): Promise<T> => {
    for (let i = 0; i < tries; i++) {
      const value = await read().catch(() => undefined);
      if (value !== undefined && done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never saw ${what}\n${service?.log().slice(-4_000) ?? ''}`);
  };

  return {
    boot: async (build, env) => {
      const which =
        build === 'this' ? { service: THIS_SERVICE } : { service: earlier!.service, earlier: true };
      service = await bootService({ ...which, databaseUrl, env });
      dbos ??= await connectSystemDatabase(databaseUrl);
      return service;
    },
    migrate: async (build) => {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/migrate-db.mjs'], {
        cwd: build === 'this' ? THIS_SERVICE : earlier!.service,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      return `${stdout}${stderr}`;
    },
    db: () => db!,
    fixtureUrl: (path) => `http://127.0.0.1:${(fixture.address() as AddressInfo).port}${path}`,
    post: (path, body) =>
      fetch(`${service!.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    eventually,
    runs: async () => {
      const { rows } = await db!.query<RunRow>(
        `SELECT run_id, status, error, finished_at, decided_by FROM runtime_runs ORDER BY run_id`,
      );
      return Object.fromEntries(rows.map((r) => [r.run_id, r]));
    },
    workflows: async () => {
      const { rows } = await dbos!.query<{ workflow_uuid: string; status: string }>(
        `SELECT workflow_uuid, status FROM dbos.workflow_status`,
      );
      return Object.fromEntries(rows.map((r) => [r.workflow_uuid.slice(MOCK_USER_ID.length + 1), r.status]));
    },
  };
}

async function connectSystemDatabase(databaseUrl: string): Promise<Client> {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname}_dbos`;
  const dbos = new Client({ connectionString: url.toString() });
  await dbos.connect();
  return dbos;
}
