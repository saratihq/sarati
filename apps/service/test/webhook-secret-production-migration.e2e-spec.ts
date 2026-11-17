import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { CANARIES } from '../src/database/schema-guard';
import { seedDefaultEnvironments } from '../src/environments/default-environments';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M049_FILE = '049_webhook_secret_production.sql';
const M049 = readFileSync(join(__dirname, '..', 'db', 'migrations', M049_FILE), 'utf8');

interface SecretRow {
  workflow_id: string;
  environment_id: string | null;
  node_id: string;
  secret: string;
}

const inOrder = (rows: SecretRow[]): SecretRow[] =>
  [...rows].sort((a, b) => (a.secret < b.secret ? -1 : a.secret > b.secret ? 1 : 0));

const gave = (node: string, workflow: string, production: string): string =>
  `049 gave the signing secret of trigger ${node} in workflow ${workflow}, which named no environment, to its production environment ${production}: a delivery there is checked against it wherever that trigger has Verify signatures on`;
const deleted = (node: string, workflow: string, production: string): string =>
  `049 deleted the signing secret of trigger ${node} in workflow ${workflow} that named no environment: its production environment ${production} has its own, the one deliveries there are checked against`;

describe("migration 049: a workspace secret that named no environment is production's (scratch DB)", () => {
  let db: Client;
  const warnings: string[] = [];
  const [org, otherOrg] = [randomUUID(), randomUUID()];
  const [moved, kept, stagingOnly, otherNode, elsewhere, orgless] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  let production = '';
  let staging = '';
  let otherProduction = '';

  const secrets = async (): Promise<SecretRow[]> =>
    inOrder(
      (
        await db.query<SecretRow>(
          `SELECT workflow_id, environment_id, node_id, secret FROM webhook_trigger_secrets`,
        )
      ).rows,
    );
  const canaryPasses = async (): Promise<boolean> =>
    ((await db.query(CANARIES.find((c) => c.migration === M049_FILE)!.probe)).rowCount ?? 0) > 0;
  const envId = async (orgId: string, name: string): Promise<string> =>
    (
      await db.query<{ id: string }>(`SELECT id FROM environments WHERE org_id = $1 AND lower(name) = $2`, [
        orgId,
        name,
      ])
    ).rows[0]!.id;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    db.on('notice', (notice) => {
      if (notice.severity === 'WARNING') warnings.push(notice.message ?? '');
    });
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'o', false, now(), now()), ($2, 'other', false, now(), now())`,
      [org, otherOrg],
    );
    await seedDefaultEnvironments(db, org);
    await seedDefaultEnvironments(db, otherOrg);
    await db.query(`UPDATE environments SET name = 'Production' WHERE org_id = $1 AND name = 'production'`, [
      otherOrg,
    ]);
    production = await envId(org, 'production');
    staging = await envId(org, 'staging');
    otherProduction = await envId(otherOrg, 'production');
    await db.query(
      `INSERT INTO workflows (id, name, org_id) VALUES
         ($1, 'moved', $7), ($2, 'kept', $7), ($3, 'staging only', $7), ($4, 'other node', $7),
         ($5, 'elsewhere', $8), ($6, 'org-less', NULL)`,
      [moved, kept, stagingOnly, otherNode, elsewhere, orgless, org, otherOrg],
    );
    await db.query(
      `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret) VALUES
         ($1, NULL, 'trigger', 'moved-trigger'),
         ($1, NULL, 'hook-2',  'moved-hook-2'),
         ($2, NULL, 'trigger', 'kept-unnamed'),
         ($2, $7,   'trigger', 'kept-production'),
         ($2, $8,   'trigger', 'kept-staging'),
         ($3, NULL, 'trigger', 'staging-only-unnamed'),
         ($3, $8,   'trigger', 'staging-only-staging'),
         ($4, NULL, 'hook-2',  'other-node-unnamed'),
         ($4, $7,   'trigger', 'other-node-production'),
         ($5, NULL, 'trigger', 'elsewhere-unnamed'),
         ($6, NULL, 'trigger', 'org-less')`,
      [moved, kept, stagingOnly, otherNode, elsewhere, orgless, production, staging],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it("gives each to its own workspace's production, drops one production already has for that trigger, leaves a workflow in no workspace its own, and a re-run changes nothing", async () => {
    expect(await canaryPasses()).toBe(false);

    await db.query(M049);
    const once = await secrets();
    const reported = [...warnings];
    await db.query(M049);

    expect(await secrets()).toEqual(once);
    expect(warnings).toEqual(reported);
    expect(once).toEqual(
      inOrder([
        { workflow_id: moved, environment_id: production, node_id: 'trigger', secret: 'moved-trigger' },
        { workflow_id: moved, environment_id: production, node_id: 'hook-2', secret: 'moved-hook-2' },
        { workflow_id: kept, environment_id: production, node_id: 'trigger', secret: 'kept-production' },
        { workflow_id: kept, environment_id: staging, node_id: 'trigger', secret: 'kept-staging' },
        {
          workflow_id: stagingOnly,
          environment_id: production,
          node_id: 'trigger',
          secret: 'staging-only-unnamed',
        },
        {
          workflow_id: stagingOnly,
          environment_id: staging,
          node_id: 'trigger',
          secret: 'staging-only-staging',
        },
        {
          workflow_id: otherNode,
          environment_id: production,
          node_id: 'hook-2',
          secret: 'other-node-unnamed',
        },
        {
          workflow_id: otherNode,
          environment_id: production,
          node_id: 'trigger',
          secret: 'other-node-production',
        },
        {
          workflow_id: elsewhere,
          environment_id: otherProduction,
          node_id: 'trigger',
          secret: 'elsewhere-unnamed',
        },
        { workflow_id: orgless, environment_id: null, node_id: 'trigger', secret: 'org-less' },
      ]),
    );
    expect([...reported].sort()).toEqual(
      [
        gave('trigger', moved, production),
        gave('hook-2', moved, production),
        deleted('trigger', kept, production),
        gave('trigger', stagingOnly, production),
        gave('hook-2', otherNode, production),
        gave('trigger', elsewhere, otherProduction),
      ].sort(),
    );
    expect(await canaryPasses()).toBe(true);
  });
});
