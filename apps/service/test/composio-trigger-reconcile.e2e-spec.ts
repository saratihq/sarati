import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { ComposioTriggerProvider } from '../src/providers/composio-trigger.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/** A manual-trigger workflow: no desired composio activation, so a seeded row converges to a teardown (F2). */
const manualDoc = (name: string): Record<string, unknown> => ({
  version: '1.0',
  name,
  description: '',
  nodes: [
    {
      id: 'trigger',
      name: 'Manual',
      node_type: 'orchestr:trigger',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
    {
      id: 'say',
      name: 'Say',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts: ['hi'], separator: '' },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'say',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

/** A workflow whose `<app>.<trigger>` node (marked `metadata.trigger`) classifies as `composio_subscription` (F1). */
const composioTriggerDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'composio-sub target',
  description: '',
  nodes: [
    {
      id: 'sub',
      name: 'On new deal',
      // A non-native, non-SDK, non-gmail `<app>.<trigger>` → the composio_subscription rail.
      node_type: 'acmecrm.new_deal',
      type_version: 1,
      parameters: { pipeline: 'default' },
      position: { x: 0, y: 0 },
      metadata: { trigger: true },
    },
    {
      id: 'say',
      name: 'Say',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts: ['hi'], separator: '' },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e',
      source_node_id: 'sub',
      source_port: 0,
      target_node_id: 'say',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

/** The Composio-subscription reconciler lifecycle (ADR 0046); the v3 client is spied, so no live call. */
describe('Composio trigger reconcile lifecycle (ADR 0046, e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  const userId = randomUUID();
  const orgId = randomUUID();
  const keyA = 'ork_e2e_comporeconcile_aaaaaaaaaaaa';
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const reconciler = (): TriggerReconcilerService => app.get(TriggerReconcilerService);

  const deploy = async (doc: Record<string, unknown>): Promise<string> => {
    const res = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: doc }),
    ).expect(201);
    return res.body.workflow_id as string;
  };

  const prodPointer = async (wfId: string): Promise<{ environmentId: string; versionId: string }> => {
    const r = await db.query<{ environment_id: string; version_id: string }>(
      `SELECT environment_id, version_id FROM workflow_env_pointers
        WHERE workflow_id = $1 AND environment_id IS NOT NULL LIMIT 1`,
      [wfId],
    );
    const row = r.rows[0];
    if (!row) throw new Error('deploy did not materialize a production env pointer');
    return { environmentId: row.environment_id, versionId: row.version_id };
  };

  /** Seed a live composio_subscription activation bound to an instance id (no reconcile needed). */
  const seedComposioActivation = async (wfId: string, instanceId: string, nodeId: string): Promise<void> => {
    const { environmentId, versionId } = await prodPointer(wfId);
    await db.query(
      `INSERT INTO runtime_trigger_activations
         (id, workflow_id, environment_id, trigger_node_id, kind, trigger_type, version_id,
          props, composio_trigger_instance_id, connection_owner_user_id, paused, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'composio_subscription', 'acmecrm.new_deal', $5,
               '{}'::json, $6, $7, false, now(), now())`,
      [randomUUID(), wfId, environmentId, nodeId, versionId, instanceId, userId],
    );
  };

  const countActivations = async (instanceId: string): Promise<number> => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM runtime_trigger_activations WHERE composio_trigger_instance_id = $1`,
      [instanceId],
    );
    return Number(r.rows[0]?.n ?? '0');
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    const keyHash = createHash('sha256').update(keyA, 'utf8').digest('hex');
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'r@e2e.local', 'R', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'R', true, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userId, keyHash, keyA.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    // Rail configured (fake key) — subscribe/delete are spied, so no live call.
    process.env.COMPOSIO_API_KEY = 'ck_e2e_fake_key';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  describe('refcounted teardown of a SHARED instance (F2)', () => {
    let wf1 = '';
    let wf2 = '';
    let deleteSpy: jest.SpyInstance;

    beforeAll(async () => {
      wf1 = await deploy(manualDoc('refcount wf1'));
      wf2 = await deploy(manualDoc('refcount wf2'));
    });

    beforeEach(() => {
      deleteSpy = jest.spyOn(app.get(ComposioTriggerProvider), 'deleteTriggerInstance').mockResolvedValue();
    });
    afterEach(() => deleteSpy.mockRestore());

    it('deletes the shared instance only when the LAST holder tears down', async () => {
      const instance = 'ti_shared_seq';
      await seedComposioActivation(wf1, instance, 'sub');
      await seedComposioActivation(wf2, instance, 'sub');

      // First holder tears down — a co-subscriber remains, so the instance is NOT deleted.
      await reconciler().reconcile(wf1);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await countActivations(instance)).toBe(1); // wf1's row gone, wf2's remains

      // Last holder tears down — now the instance is deleted exactly once.
      await reconciler().reconcile(wf2);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith(instance);
      expect(await countActivations(instance)).toBe(0);
    });

    it('CONCURRENT last-two teardowns delete the shared instance exactly once (no leak)', async () => {
      const instance = 'ti_shared_conc';
      await seedComposioActivation(wf1, instance, 'sub');
      await seedComposioActivation(wf2, instance, 'sub');

      // The FOR UPDATE lock over the rows sharing this ti_ serializes count → clear-id.
      await Promise.all([reconciler().reconcile(wf1), reconciler().reconcile(wf2)]);

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith(instance);
      expect(await countActivations(instance)).toBe(0);
    });
  });

  describe('self-healing re-subscribe of a converged activation (F1)', () => {
    let wf = '';
    let slotSpy: jest.SpyInstance;
    let refSpy: jest.SpyInstance;
    let createSpy: jest.SpyInstance;
    const connId = randomUUID();

    const activationRow = async (): Promise<{ id: string; composio_trigger_instance_id: string | null }> => {
      const r = await db.query<{ id: string; composio_trigger_instance_id: string | null }>(
        `SELECT id, composio_trigger_instance_id FROM runtime_trigger_activations
          WHERE workflow_id = $1 AND kind = 'composio_subscription' LIMIT 1`,
        [wf],
      );
      const row = r.rows[0];
      if (!row) throw new Error('no composio activation materialized');
      return row;
    };

    beforeAll(async () => {
      // Spied BEFORE deploy so the inline reconcile resolves a slot and subscribes with no live call.
      slotSpy = jest
        .spyOn(app.get(ConnectionsService), 'resolveSlotConnection')
        .mockResolvedValue({ id: connId, ownerUserId: userId });
      refSpy = jest.spyOn(app.get(ConnectionsService), 'managedRef').mockResolvedValue({
        id: connId,
        authType: 'managed',
        status: 'active',
        connectedAccountId: 'ca_1',
      });
      createSpy = jest
        .spyOn(app.get(ComposioTriggerProvider), 'createTriggerInstance')
        .mockResolvedValue('ti_fresh');
      wf = await deploy(composioTriggerDoc());
    });

    afterAll(() => {
      slotSpy.mockRestore();
      refSpy.mockRestore();
      createSpy.mockRestore();
    });

    it('re-subscribes (idempotent upsert) on the sweep — repairs a diverged ti_', async () => {
      await reconciler().reconcile(wf, { selfHeal: true }); // create + subscribe (idempotent)
      const seeded = await activationRow();
      expect(seeded.composio_trigger_instance_id).toBe('ti_fresh');

      // Simulate divergence: the stored id points at an instance Composio no longer has.
      await db.query(
        `UPDATE runtime_trigger_activations SET composio_trigger_instance_id = 'ti_stale' WHERE id = $1`,
        [seeded.id],
      );

      // The descriptor is unchanged (empty plan), so only the sweep's self-heal can repair the id.
      const before = createSpy.mock.calls.length;
      await reconciler().reconcile(wf, { selfHeal: true });
      expect(createSpy.mock.calls.length).toBeGreaterThan(before); // re-subscribed
      expect((await activationRow()).composio_trigger_instance_id).toBe('ti_fresh'); // repaired
    });

    // FIX B: self-heal re-verify is SWEEP-ONLY — an inline reconcile must not pay a Composio round trip.
    it('self-heal re-verify runs on the SWEEP path only, not an inline reconcile', async () => {
      await reconciler().reconcile(wf, { selfHeal: true }); // converge (row exists, id set)
      await activationRow();

      const beforeInline = createSpy.mock.calls.length;
      await reconciler().reconcile(wf); // inline path (no selfHeal) — must NOT re-subscribe
      expect(createSpy.mock.calls.length).toBe(beforeInline);

      await reconciler().reconcile(wf, { selfHeal: true }); // sweep path DOES re-verify
      expect(createSpy.mock.calls.length).toBeGreaterThan(beforeInline);
    });

    // FIX A: self-heal reads pre-sweep state, so an id-write hitting 0 rows orphans the fresh ti_.
    it('compensates (deletes the fresh ti_) when its row-write hits 0 rows', async () => {
      await reconciler().reconcile(wf, { selfHeal: true }); // converge
      const seeded = await activationRow();

      const deleteSpy = jest
        .spyOn(app.get(ComposioTriggerProvider), 'deleteTriggerInstance')
        .mockResolvedValue();
      // Simulate a concurrent reconcile deleting the row DURING the upsert.
      createSpy.mockImplementationOnce(async () => {
        await db.query(`DELETE FROM runtime_trigger_activations WHERE id = $1`, [seeded.id]);
        return 'ti_orphaned';
      });

      await reconciler().reconcile(wf, { selfHeal: true });

      expect(deleteSpy).toHaveBeenCalledWith('ti_orphaned');
      deleteSpy.mockRestore();
    });
  });

  // FIX C: the two-strike reaper deletes any live Composio instance no live activation references.
  describe('orphan reaper deletes an unreferenced instance, keeps a referenced one (FIX C)', () => {
    let wf = '';
    let listSpy: jest.SpyInstance;
    let deleteSpy: jest.SpyInstance;
    const triggers = (): TriggersService => app.get(TriggersService);

    beforeAll(async () => {
      wf = await deploy(manualDoc('reaper wf'));
      await seedComposioActivation(wf, 'ti_referenced', 'sub'); // a LIVE (paused=false) row holds it
    });

    beforeEach(() => {
      deleteSpy = jest.spyOn(app.get(ComposioTriggerProvider), 'deleteTriggerInstance').mockResolvedValue();
      listSpy = jest
        .spyOn(app.get(ComposioTriggerProvider), 'listActiveInstanceIds')
        .mockResolvedValue(['ti_referenced', 'ti_orphan']);
    });
    afterEach(() => {
      deleteSpy.mockRestore();
      listSpy.mockRestore();
    });

    it('reaps ti_orphan after two strikes, never ti_referenced', async () => {
      // Two-strike grace: the first pass only records the candidate, guarding a subscribe mid-flight.
      await triggers().reapOrphanedComposioSubscriptions();
      expect(deleteSpy).not.toHaveBeenCalled();

      // Second pass: orphaned on both → deleted; ti_referenced is held by a live row → kept.
      await triggers().reapOrphanedComposioSubscriptions();
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith('ti_orphan');
      expect(deleteSpy).not.toHaveBeenCalledWith('ti_referenced');
    });
  });
});
