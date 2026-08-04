import { SchemaGuard } from './schema-guard';

import type { Pool } from 'pg';

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
