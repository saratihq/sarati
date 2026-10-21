import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

import type { GoldenOutcome } from './golden-outcome';

/** Where the recorded histories live, one `<build>/<shape>.json` each, `<build>` the recording commit's short sha. */
export const GOLDEN_DIR = join(__dirname, '..', 'golden');

type Row = Record<string, unknown>;

/** One run as an earlier build left it at a crash: its app rows and its DBOS rows, verbatim. */
export interface GoldenHistory {
  /** The commit of the build that recorded it. */
  build: string;
  /** When it was recorded, in epoch ms. */
  recordedAt: number;
  /** The run's id as the API names it; unique to the history, so a restore can rename it. */
  runId: string;
  /** The org the run ran in, which a restore swaps for its user's own. */
  orgId: string | null;
  /** The run's rows in the app database, by table, in insert order. */
  app: Record<string, Row[]>;
  /** The run's rows in the DBOS system database, by table. */
  dbos: Record<string, Row[]>;
  /** What the recording build made of the run when it recovered, for a run it resumes. */
  outcome?: GoldenOutcome;
}

/** The build before this one — v0.2.24, the release that added the recovery guard — as the short sha its histories are kept under: record them again when it changes. */
export const PREVIOUS_BUILD = 'bdf9cd7';

/** The shapes recorded from `build`, each restored as `<build>/<shape>`. */
export function goldenShapes(build = PREVIOUS_BUILD): string[] {
  return readdirSync(join(GOLDEN_DIR, build))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length));
}

/** The full sha of the build every history under `build` came from. */
export function goldenBuild(build = PREVIOUS_BUILD): string {
  const builds = new Set(
    goldenShapes(build).map(
      (shape) =>
        (JSON.parse(readFileSync(join(GOLDEN_DIR, build, `${shape}.json`), 'utf8')) as GoldenHistory).build,
    ),
  );
  const [sha] = builds;
  if (builds.size !== 1 || !sha?.startsWith(build))
    throw new Error(`the histories under ${build} come from ${[...builds].join(', ')}: record them again`);
  return sha;
}

// Row ids the app keys rows by alone, so each restore of one history takes fresh ones.
const FRESH_IDS: Record<string, string> = { runtime_run_steps: 'id', runtime_blobs: 'id' };

/**
 * Restore a recorded run under `runId`, every time in it moved forward by its age, and `replace` swapping any other
 * recorded text, such as an address it called: a boot then recovers it as that build's run, just crashed. Restore it
 * while no service runs on these databases.
 */
export async function restoreGoldenHistory(
  db: Client,
  dbos: Client,
  shape: string,
  runId: string,
  replace: Readonly<Record<string, string>> = {},
): Promise<void> {
  const raw = readFileSync(join(GOLDEN_DIR, `${shape}.json`), 'utf8');
  const recorded = JSON.parse(raw) as GoldenHistory;
  let renamed = raw.replaceAll(recorded.runId, runId);
  if (recorded.orgId) renamed = renamed.replaceAll(recorded.orgId, await personalOrg(db, recorded));
  for (const [from, to] of Object.entries(replace)) renamed = renamed.replaceAll(from, to);
  const history = JSON.parse(renamed) as GoldenHistory;
  const age = Date.now() - history.recordedAt;
  for (const [table, rows] of Object.entries(history.app)) {
    const times = await columnsOf(db, 'public', table, `data_type LIKE 'timestamp%'`);
    const fresh = FRESH_IDS[table];
    await insert(
      db,
      `public.${table}`,
      rows.map((row) => ({
        ...shifted(row, times, (at) => new Date(Date.parse(at as string) + age).toISOString()),
        ...(fresh ? { [fresh]: randomUUID() } : {}),
      })),
    );
  }
  for (const [table, rows] of Object.entries(history.dbos)) {
    const times = await columnsOf(
      dbos,
      'dbos',
      table,
      `data_type = 'bigint' AND column_name ~ '(_at|_epoch_ms)$'`,
    );
    await insert(
      dbos,
      `dbos.${table}`,
      rows.map((row) =>
        sleptUntil(
          shifted(row, times, (at) => (at as number) + age),
          age,
        ),
      ),
    );
  }
}

async function personalOrg(db: Client, recorded: GoldenHistory): Promise<string> {
  const userId = recorded.app.runtime_runs?.[0]?.user_id;
  const res = await db.query<{ org_id: string }>(
    `SELECT m.org_id FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND o.is_personal`,
    [userId],
  );
  if (!res.rows[0])
    throw new Error(`no personal org for ${String(userId)}: let the service provision its user first`);
  return res.rows[0].org_id;
}

async function columnsOf(client: Client, schema: string, table: string, where: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND ${where}`,
    [schema, table],
  );
  return res.rows.map((r) => r.column_name);
}

function shifted(row: Row, columns: string[], move: (at: unknown) => unknown): Row {
  const out = { ...row };
  for (const column of columns)
    if (out[column] !== null && out[column] !== undefined) out[column] = move(out[column]);
  return out;
}

// A durable sleep's op records the instant it wakes at, which moves with the rest.
function sleptUntil(row: Row, age: number): Row {
  if (row.function_name !== 'DBOS.sleep') return row;
  if (row.serialization !== 'portable_json')
    throw new Error(`a sleep recorded as ${String(row.serialization)}`);
  return { ...row, output: JSON.stringify((JSON.parse(row.output as string) as number) + age) };
}

async function insert(client: Client, table: string, rows: Row[]): Promise<void> {
  await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1)`, [
    JSON.stringify(rows),
  ]);
}
