import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Pool } from 'pg';

import { PG_POOL } from './tokens';

/**
 * Boot-time schema canaries so a database behind the code fails fast. Every new file in
 * db/migrations/ MUST add one canary here probing the artifact it creates.
 */
const CANARIES: Array<{ migration: string; probe: string }> = [
  {
    migration: '001-003 (env clusters)',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='connections' AND column_name='environment'",
  },
  {
    migration: '004_connection_health.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='connections' AND column_name='status_reason'",
  },
  {
    migration: '005_env_promotion_pointers.sql',
    probe: "SELECT 1 FROM information_schema.tables WHERE table_name='workflow_env_pointers'",
  },
  {
    migration: '006_environments.sql',
    probe: "SELECT 1 FROM information_schema.tables WHERE table_name='environments'",
  },
  {
    migration: '008_production_rename.sql',
    // Data canary: a lingering is_prod row still NAMED 'prod' means 008 never ran.
    probe: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM environments WHERE is_prod AND lower(name)='prod')",
  },
  {
    migration: '007_composer_threads.sql',
    probe: "SELECT 1 FROM information_schema.tables WHERE table_name='composer_threads'",
  },
  {
    migration: '009_trigger_activations.sql',
    probe: "SELECT 1 FROM information_schema.tables WHERE table_name='runtime_trigger_activations'",
  },
  {
    migration: '010_drop_engine_layer.sql',
    // A DROP canary: the engine_type column still present means 010 never ran.
    probe:
      "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflows' AND column_name='engine_type')",
  },
  {
    migration: '011_run_step_pinned.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_run_steps' AND column_name='pinned'",
  },
  {
    migration: '012_run_step_continued.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_run_steps' AND column_name='continued'",
  },
  {
    migration: '013_run_step_attempts.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_run_steps' AND column_name='attempts'",
  },
  {
    migration: '014_drop_legacy_triggers.sql',
    // A DROP canary: the legacy runtime_triggers table still present means 014 never ran.
    probe: "SELECT 1 WHERE to_regclass('public.runtime_triggers') IS NULL",
  },
  {
    migration: '015_review_test.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_runs' AND column_name='review_id'",
  },
  {
    migration: '016_connections_fks.sql',
    probe:
      "SELECT 1 FROM information_schema.table_constraints WHERE table_name='connections' AND constraint_name='connections_org_id_fkey' AND constraint_type='FOREIGN KEY'",
  },
  {
    migration: '017_webhook_secrets.sql',
    probe: "SELECT 1 FROM information_schema.tables WHERE table_name='webhook_trigger_secrets'",
  },
  {
    migration: '018_run_dry_run.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_runs' AND column_name='dry_run'",
  },
  {
    migration: '019_byo_oauth_client.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='connections' AND column_name='oauth_client'",
  },
  {
    migration: '020_composio_trigger_instance.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_trigger_activations' AND column_name='composio_trigger_instance_id'",
  },
  {
    migration: '021_run_step_ref_warnings.sql',
    probe:
      "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_run_steps' AND column_name='warnings'",
  },
  {
    migration: '022_composio_webhook_deliveries.sql',
    probe: "SELECT 1 FROM information_schema.tables WHERE table_name='composio_webhook_deliveries'",
  },
];

@Injectable()
export class SchemaGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaGuard.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    const missing: string[] = [];
    for (const { migration, probe } of CANARIES) {
      const res = await this.pool.query(probe);
      if (res.rowCount === 0) missing.push(migration);
    }
    if (missing.length > 0) {
      this.logger.error(
        `Database schema is behind the code — missing artifacts from: ${missing.join(', ')}. ` +
          'Run `pnpm db:migrate` (idempotent) against this DATABASE_URL, then start the service again.',
      );
      throw new Error('schema out of date — run pnpm db:migrate');
    }
  }
}
