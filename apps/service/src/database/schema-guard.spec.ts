import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CANARIES, NO_SURVIVING_ARTIFACT, SchemaGuard } from './schema-guard';

import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const migrationsOnDisk = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

describe('canary completeness', () => {
  const declared = new Set([...CANARIES.map((c) => c.migration), ...NO_SURVIVING_ARTIFACT]);

  it('covers every migration on disk with a canary or a named exemption', () => {
    expect(migrationsOnDisk().filter((file) => !declared.has(file))).toEqual([]);
  });

  it('declares no canary for a migration that does not exist', () => {
    const onDisk = new Set(migrationsOnDisk());
    expect([...declared].filter((file) => !onDisk.has(file)).sort()).toEqual([]);
  });
});

describe('SchemaGuard', () => {
  const poolOf = (rowCountByProbe: (probe: string) => number): Pool =>
    ({
      query: (probe: string) => Promise.resolve({ rowCount: rowCountByProbe(probe) }),
    }) as unknown as Pool;

  it('passes silently when every canary artifact exists', async () => {
    const guard = new SchemaGuard(poolOf(() => 1));
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('fails fast naming the missing migration and pnpm db:migrate', async () => {
    const guard = new SchemaGuard(poolOf((probe) => (probe.includes('workflow_env_pointers') ? 0 : 1)));
    await expect(guard.onApplicationBootstrap()).rejects.toThrow(/db:migrate/);
  });
});
