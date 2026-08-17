import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { WebhookRegistration } from '@sarati/actions-sdk';
import { Not } from 'typeorm';
import type { DataSource } from 'typeorm';

import { runBounded } from '../../common/bounded';
import { errorMessage } from '../../common/error-message';
import { isTriggerNode } from '../../compiler/compile-ir';
import { ConnectionsService } from '../../connections/connections.service';
import type { EnvConfig } from '../../config/env.config';
import { newId, now } from '../../database/ids';
import { rawQuery } from '../../database/raw-query';
import { RuntimeTriggerActivationEntity } from '../../database/entities/runtime-trigger-activation.entity';
import { deepEqual, type IRNode, type WorkflowIR } from '../../ir/models';
import { composioTriggerSpec } from '../../providers/composio-trigger.registry';
import { ComposioTriggerProvider } from '../../providers/composio-trigger.provider';
import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
} from '../../providers/managed-integration-provider';
import { validatedAppSlug } from '../../providers/sdk-actions.registry';
import { SdkPollingProvider } from '../../providers/sdk-polling.provider';
import {
  SdkWebhookProvider,
  WEBHOOK_REGISTRATION_KEY,
  WEBHOOK_SECRET_KEY,
} from '../../providers/sdk-webhook.provider';
import { DbActivationStore } from '../activation-store';
import { INCOMING_CHAT_PUBLIC, INCOMING_WEBHOOK_PUBLIC, MANUAL_TRIGGER } from '../trigger-catalog.service';
import { ORCHESTR_SCHEDULE, SCHEDULE_CURSOR_KEY } from '../schedule';
import { TriggerSignalsService } from '../trigger-signals.service';
import { webhookUrlFor } from './webhook-url';
import {
  activationKeyString,
  type ActivationKind,
  type ActualActivation,
  connectionEqual,
  type ConnectionRef,
  type DesiredActivation,
} from './trigger-activation';
import { triggerConfigChangedAcrossVersions } from './trigger-config-diff';
import { PlatformKeysService, type PlatformKeyScope } from '../../platform/platform-keys.service';
import {
  deriveDesiredActivations,
  reconcileActivations,
  type EnvPointerInput,
  type ReconcilePlan,
} from './reconcile';

/** Cap the self-heal re-subscribe fan-out so one slow Composio upsert can't stall the whole sweep. */
const SELFHEAL_CONCURRENCY = 5;

/** One env pointer as reconcile reads it: which version answers, in which env (id + name). */
interface PointerRow {
  environment_id: string;
  environment: string;
  version_id: string;
}

/**
 * The trigger-activation RECONCILER (ADR 0018) — the definition site of the invariant
 * "trigger activations are derived state": DESIRED (env pointers × version-doc trigger
 * nodes) diffed against ACTUAL (`runtime_trigger_activations`), applied idempotently.
 * Trigger identity comes from the compiler's `isTriggerNode` — never re-declared here.
 */
@Injectable()
export class TriggerReconcilerService {
  private readonly logger = new Logger(TriggerReconcilerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sdkWebhooks: SdkWebhookProvider,
    private readonly sdkPolling: SdkPollingProvider,
    @Inject(MANAGED_INTEGRATION_PROVIDER) private readonly lifecycle: ManagedIntegrationProvider,
    private readonly composioTriggers: ComposioTriggerProvider,
    private readonly connections: ConnectionsService,
    private readonly signals: TriggerSignalsService,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  /** Wire the inline reconcile path so pointer/slot moves converge even when pg-boss is off. */
  registerInline(): void {
    // Inline reconciles do NOT run the self-heal re-verify pass — that is sweep-only.
    this.signals.registerInline((workflowId) => this.reconcile(workflowId));
  }

  /**
   * Converge ONE workflow's activations to its desired set — total + idempotent. Reads
   * COMMITTED pointers, so callers must enqueue after their move's transaction commits.
   * `selfHeal` is sweep-only: it costs a Composio round trip per subscription row.
   */
  async reconcile(workflowId: string, opts: { selfHeal?: boolean } = {}): Promise<void> {
    const em = this.dataSource.manager;
    const pointers = await rawQuery<PointerRow>(
      em,
      `SELECT environment_id, environment, version_id
         FROM workflow_env_pointers
        WHERE workflow_id = $1 AND environment_id IS NOT NULL`,
      [workflowId],
    );

    const envNameById = new Map(pointers.map((p) => [p.environment_id, p.environment]));
    const irByVersion = await this.loadIrs(pointers.map((p) => p.version_id));
    const pointerInputs: EnvPointerInput[] = [];
    for (const p of pointers) {
      const ir = irByVersion.get(p.version_id);
      if (ir) pointerInputs.push({ environmentId: p.environment_id, versionId: p.version_id, ir });
    }

    // The pure derive is synchronous, so slots must be resolved up front.
    const connByEnvApp = await this.resolveConnections(pointerInputs);
    const desired = deriveDesiredActivations({
      workflowId,
      pointers: pointerInputs,
      kindOf: (node) => this.kindOf(node),
      connectionOf: (envId, node) => connByEnvApp.get(slotKey(envId, node)) ?? null,
    });

    const actualRows = await em.find(RuntimeTriggerActivationEntity, { where: { workflowId } });
    const rowByKey = new Map(actualRows.map((r) => [activationKeyString(keyOf(r)), r]));
    const actual: ActualActivation[] = actualRows.map((r) => toDesired(r));

    const plan = reconcileActivations(desired, actual);
    // Each op is isolated: a failure lands on the row's `last_error` and never aborts the
    // rest of the sweep — the next reconcile re-converges.
    for (const d of plan.toCreate) {
      await this.applyCreate(d, envNameById).catch((err) => this.logApplyError('create', d.key, err));
    }
    for (const u of plan.toUpdate) {
      const row = rowByKey.get(activationKeyString(u.actual.key));
      if (row)
        await this.applyUpdate(row, u.desired, envNameById, irByVersion).catch((err) =>
          this.logApplyError('update', u.desired.key, err),
        );
    }
    for (const d of plan.toDelete) {
      const row = rowByKey.get(activationKeyString(d.key));
      if (row) await this.applyDelete(row).catch((err) => this.logApplyError('delete', d.key, err));
    }
    if (opts.selfHeal) await this.selfHealComposioSubscriptions(desired, rowByKey, plan);
  }

  /**
   * Re-subscribe every live `composio_subscription` the plan didn't already materialize,
   * repairing a stored `ti_…` that diverged from Composio (the upsert is idempotent, so an
   * already-correct row is a no-op). Sweep-only, and bounded-parallel to spare the upstream.
   */
  private async selfHealComposioSubscriptions(
    desired: DesiredActivation[],
    rowByKey: Map<string, RuntimeTriggerActivationEntity>,
    plan: ReconcilePlan,
  ): Promise<void> {
    // Rows the plan already stood up this sweep — don't pay a second upsert for them.
    const materialized = new Set<string>();
    for (const d of plan.toCreate) materialized.add(activationKeyString(d.key));
    for (const u of plan.toUpdate) {
      if (u.cursorAction === 'reset') materialized.add(activationKeyString(u.actual.key));
    }
    const targets: Array<{ id: string; desired: DesiredActivation }> = [];
    for (const d of desired) {
      if (d.kind !== 'composio_subscription' || d.paused) continue;
      if (this.needsConnection(d) && d.connection === null) continue; // unfilled slot → last_error, not a subscribe
      const keyStr = activationKeyString(d.key);
      if (materialized.has(keyStr)) continue;
      const row = rowByKey.get(keyStr);
      if (!row) continue; // no actual row yet — the next sweep converges it
      targets.push({ id: row.id, desired: d });
    }
    await runBounded(targets, SELFHEAL_CONCURRENCY, ({ id, desired: d }) =>
      this.materialize(id, d, new Map(), 'keep').catch((err) => this.logApplyError('selfheal', d.key, err)),
    );
  }

  private logApplyError(op: string, key: DesiredActivation['key'], err: unknown): void {
    this.logger.warn(`activation ${op} ${activationKeyString(key)} failed: ${errorMessage(err)}`);
  }

  /**
   * Reconcile every workflow with an env pointer OR a materialized activation (the latter so
   * a fully-unpromoted workflow still gets torn down). The periodic full-sweep safety net.
   */
  async sweepAll(): Promise<void> {
    const em = this.dataSource.manager;
    const rows = await rawQuery<{ workflow_id: string }>(
      em,
      `SELECT DISTINCT workflow_id FROM workflow_env_pointers WHERE environment_id IS NOT NULL
       UNION
       SELECT DISTINCT workflow_id FROM runtime_trigger_activations`,
    );
    for (const { workflow_id } of rows) {
      try {
        // The sweep is the ONLY caller that runs the self-heal re-verify pass.
        await this.reconcile(workflow_id, { selfHeal: true });
      } catch (err) {
        this.logger.error(`reconcile sweep of ${workflow_id} failed: ${errorMessage(err)}`);
      }
    }
    if (rows.length > 0) this.logger.log(`trigger reconcile sweep: ${rows.length} workflow(s)`);
  }

  // ─── apply ───

  private async applyCreate(desired: DesiredActivation, envName: Map<string, string>): Promise<void> {
    const id = newId();
    const ts = now();
    const missingSlot = this.needsConnection(desired) && desired.connection === null;
    const row = this.dataSource.manager.create(RuntimeTriggerActivationEntity, {
      id,
      workflowId: desired.key.workflowId,
      environmentId: desired.key.environmentId,
      triggerNodeId: desired.key.triggerNodeId,
      kind: desired.kind,
      triggerType: desired.triggerType,
      versionId: desired.versionId,
      props: desired.props,
      connectionId: desired.connection?.connectionId ?? null,
      connectionOwnerUserId: desired.connection?.ownerUserId ?? null,
      paused: desired.paused,
      lastPolledAt: null,
      lastError: missingSlot ? this.slotError(desired) : null,
      createdAt: ts,
      updatedAt: ts,
    });
    await this.dataSource.manager.save(RuntimeTriggerActivationEntity, row);
    if (missingSlot || desired.paused) return; // materialize later, once the slot is filled / unpaused
    await this.materialize(id, desired, envName, 'reset');
  }

  private async applyUpdate(
    row: RuntimeTriggerActivationEntity,
    desired: DesiredActivation,
    envName: Map<string, string>,
    irByVersion: Map<string, WorkflowIR>,
  ): Promise<void> {
    const cursorAction = this.cursorActionFor(row, desired, irByVersion);
    const missingSlot = this.needsConnection(desired) && desired.connection === null;
    row.kind = desired.kind;
    row.triggerType = desired.triggerType;
    row.versionId = desired.versionId;
    row.props = desired.props;
    row.connectionId = desired.connection?.connectionId ?? null;
    row.connectionOwnerUserId = desired.connection?.ownerUserId ?? null;
    row.paused = desired.paused;
    row.lastError = missingSlot ? this.slotError(desired) : null;
    row.updatedAt = now();
    await this.dataSource.manager.save(RuntimeTriggerActivationEntity, row);
    if (desired.paused) {
      // A pause tears down the live side-effect (subscription/poller) but keeps the row.
      await this.teardown(row.id, row.kind as ActivationKind, desired, envName);
      return;
    }
    if (missingSlot) {
      await this.teardown(row.id, row.kind as ActivationKind, desired, envName);
      return;
    }
    // A 'keep' leaves the cursor/subscription untouched; a 'reset' re-materializes from now.
    if (cursorAction === 'reset') {
      await this.teardown(row.id, row.kind as ActivationKind, desired, envName);
      await this.materialize(row.id, desired, envName, 'reset');
    }
  }

  private async applyDelete(row: RuntimeTriggerActivationEntity): Promise<void> {
    await this.teardown(row.id, row.kind as ActivationKind, toDesired(row), new Map());
    await this.dataSource.manager.delete(RuntimeTriggerActivationEntity, { id: row.id }); // store cascades
  }

  /**
   * Keep the dedup/schedule cursor IFF the trigger is unchanged across the promote, else
   * reset it from now. "Did the config change?" is answered by the vault authority
   * `triggerConfigChangedAcrossVersions` → `computeDiff` (invariant #4), never a byte compare.
   */
  private cursorActionFor(
    row: RuntimeTriggerActivationEntity,
    desired: DesiredActivation,
    irByVersion: Map<string, WorkflowIR>,
  ): 'keep' | 'reset' {
    if (!connectionEqual(desired.connection, connOf(row))) return 'reset';
    if (desired.paused !== row.paused) return 'reset';
    if (!row.versionId || row.versionId === desired.versionId) return 'keep'; // nothing moved
    const oldIr = irByVersion.get(row.versionId);
    const newIr = irByVersion.get(desired.versionId);
    if (!oldIr || !newIr) return deepEqual(desired.props, row.props ?? {}) ? 'keep' : 'reset';
    if (!triggerConfigChangedAcrossVersions(oldIr, newIr, desired.key.triggerNodeId)) return 'keep';
    // That check is a coarse upper bound (a position nudge flags too) — narrow it on props.
    return deepEqual(desired.props, row.props ?? {}) ? 'keep' : 'reset';
  }

  // ─── provider materialization / teardown (per kind) ───

  /** Stand up the live side-effect for an activation. `cursorAction` seeds a fresh cursor on reset. */
  private async materialize(
    activationId: string,
    desired: DesiredActivation,
    envName: Map<string, string>,
    cursorAction: 'keep' | 'reset',
  ): Promise<void> {
    try {
      const store = new DbActivationStore(this.dataSource, activationId);
      switch (desired.kind) {
        case 'schedule':
          if (cursorAction === 'reset') await store.put(SCHEDULE_CURSOR_KEY, now().toISOString());
          return;
        case 'registered_webhook':
          await this.registerWebhook(activationId, desired, envName);
          return;
        case 'polling':
          // A discarded seed poll primes the dedup watermark, so only items appearing
          // AFTER activation fire. (Each SDK trigger also self-baselines if this seed fails.)
          if (this.sdkPolling.isPollingTrigger(desired.triggerType)) {
            await this.sdkPolling.enable(desired.triggerType, {
              externalUserId: desired.connection?.ownerUserId ?? '',
              props: desired.props,
              auth: desired.connection ? { connectionId: desired.connection.connectionId } : null,
              store,
            });
            return;
          }
          await this.lifecycle.enableTrigger({
            externalUserId: desired.connection?.ownerUserId ?? '',
            triggerId: desired.triggerType,
            props: desired.props,
            auth: desired.connection ? { connectionId: desired.connection.connectionId } : undefined,
            store,
          });
          return;
        case 'composio_subscription':
          await this.subscribeComposio(activationId, desired);
          return;
        case 'webhook':
          return; // the per-(workflow,env) URL IS the deployment — nothing to stand up
        case 'chat':
          return; // ditto (ADR 0045 addendum)
      }
    } catch (err) {
      await this.recordError(activationId, err);
    }
  }

  /** Tear the live side-effect down (best-effort — teardown failures must not wedge the sweep). */
  private async teardown(
    activationId: string,
    kind: ActivationKind,
    desired: DesiredActivation,
    envName: Map<string, string>,
  ): Promise<void> {
    try {
      const store = new DbActivationStore(this.dataSource, activationId);
      if (kind === 'registered_webhook') {
        const registration = (await store.get<WebhookRegistration>(WEBHOOK_REGISTRATION_KEY)) ?? undefined;
        const secret = (await store.get<string>(WEBHOOK_SECRET_KEY)) ?? '';
        await this.sdkWebhooks.disable({
          externalUserId: desired.connection?.ownerUserId ?? '',
          type: desired.triggerType,
          props: desired.props,
          auth: desired.connection ? { connectionId: desired.connection.connectionId } : null,
          store,
          webhookUrl: this.webhookUrl(desired, envName),
          secret,
          registration,
        });
        await store.delete(WEBHOOK_REGISTRATION_KEY);
        await store.delete(WEBHOOK_SECRET_KEY);
      } else if (kind === 'polling') {
        // SDK polling holds no remote subscription (its cursor cascade-deletes with the
        // row); only the hand-polled Composio-poll rail has a disable.
        if (!this.sdkPolling.isPollingTrigger(desired.triggerType)) {
          await this.lifecycle.disableTrigger({
            externalUserId: desired.connection?.ownerUserId ?? '',
            triggerId: desired.triggerType,
            props: desired.props,
            auth: desired.connection ? { connectionId: desired.connection.connectionId } : undefined,
            store,
          });
        }
      } else if (kind === 'composio_subscription') {
        await this.unsubscribeComposio(activationId, desired.key.workflowId);
      } else if (kind === 'schedule') {
        await store.delete(SCHEDULE_CURSOR_KEY);
      }
    } catch (err) {
      this.logger.warn(`activation ${activationId} teardown (${kind}) failed: ${errorMessage(err)}`);
    }
  }

  /** Register a fresh provider subscription pointing at the per-(workflow,env) intake URL. */
  private async registerWebhook(
    activationId: string,
    desired: DesiredActivation,
    envName: Map<string, string>,
  ): Promise<void> {
    const store = new DbActivationStore(this.dataSource, activationId);
    const secret = randomBytes(32).toString('hex');
    await store.put(WEBHOOK_SECRET_KEY, secret);
    const registration = await this.sdkWebhooks.enable({
      externalUserId: desired.connection?.ownerUserId ?? '',
      type: desired.triggerType,
      props: desired.props,
      store,
      webhookUrl: this.webhookUrl(desired, envName),
      secret,
      auth: desired.connection ? { connectionId: desired.connection.connectionId } : null,
    });
    if (registration) await store.put(WEBHOOK_REGISTRATION_KEY, registration);
  }

  /**
   * Subscribe a Composio trigger INSTANCE for this activation (ADR 0046) and persist its id
   * on the row — the intake maps deliveries back through it and teardown deletes it.
   */
  private async subscribeComposio(activationId: string, desired: DesiredActivation): Promise<void> {
    const scope = await this.platformKeys.scopeForWorkflow(desired.key.workflowId);
    if (!scope || !(await this.composioTriggers.isConfigured(scope))) {
      throw new Error(
        'This trigger runs on a managed (Composio) connection, but no Composio API key is set for this workspace — add one in Settings',
      );
    }
    const conn = desired.connection;
    if (!conn) throw new Error('No connection resolved for this Composio trigger'); // guarded by missingSlot
    const ref = await this.connections.managedRef(conn.ownerUserId, conn.connectionId);
    if (!ref) throw new Error(`Connection ${conn.connectionId} not found`);
    if (ref.authType !== 'managed' || !ref.connectedAccountId) {
      throw new Error(
        'This trigger needs a managed connection — a bring-your-own connection has no Composio subscription rail',
      );
    }
    if (ref.status !== 'active') {
      throw new Error("The trigger's connection is not active yet — complete the connect flow, then retry");
    }
    const slug = this.composioTriggers.slugForPublicType(desired.triggerType);
    if (!slug) throw new Error(`Malformed Composio trigger type "${desired.triggerType}"`);

    const instanceId = await this.composioTriggers.createTriggerInstance(scope, {
      slug,
      connectedAccountId: ref.connectedAccountId,
      userId: conn.ownerUserId,
      triggerConfig: desired.props,
    });
    const { affected } = await this.dataSource.manager.update(
      RuntimeTriggerActivationEntity,
      { id: activationId },
      { composioTriggerInstanceId: instanceId },
    );
    await this.compensateIfOrphaned(scope, activationId, instanceId, affected ?? 0);
  }

  /**
   * Delete the instance we just upserted if a concurrent reconcile deleted/paused/unslotted
   * the row under us — but ONLY when no other live activation shares the `ti_…` (Composio
   * dedupes on account+slug+config, so deleting a referenced instance breaks the sibling).
   */
  private async compensateIfOrphaned(
    scope: PlatformKeyScope,
    activationId: string,
    instanceId: string,
    affected: number,
  ): Promise<void> {
    const row =
      affected > 0
        ? await this.dataSource.manager.findOne(RuntimeTriggerActivationEntity, {
            where: { id: activationId },
          })
        : null;
    const rowHolds = row !== null && !row.paused && row.connectionId !== null;
    if (rowHolds) return; // the row legitimately holds the subscription — nothing to compensate
    if (row) {
      // The row survives but can no longer hold the subscription — drop the resurrected id.
      await this.dataSource.manager.update(
        RuntimeTriggerActivationEntity,
        { id: activationId },
        { composioTriggerInstanceId: null },
      );
    }
    const otherLiveHolders = await this.dataSource.manager.count(RuntimeTriggerActivationEntity, {
      where: { composioTriggerInstanceId: instanceId, paused: false, id: Not(activationId) },
    });
    if (otherLiveHolders > 0) return; // a live sibling still needs this shared instance
    await this.composioTriggers
      .deleteTriggerInstance(scope, instanceId)
      .catch((err) => this.logger.warn(`compensating delete of ${instanceId} failed: ${errorMessage(err)}`));
  }

  /**
   * Tear down this activation's Composio subscription (ADR 0046). REFCOUNTED: activations
   * share a `ti_…`, so delete the instance only when no other activation references it;
   * always clear this row's id (non-null means "holds a live subscription").
   */
  private async unsubscribeComposio(activationId: string, workflowId: string): Promise<void> {
    // The refcount decision must be ATOMIC across co-subscribers, or two concurrent
    // teardowns each count the other and both skip the delete → the instance leaks. The
    // Composio DELETE stays outside the tx (no network under a lock).
    const instanceToDelete = await this.dataSource.transaction(async (em) => {
      const row = await em.findOne(RuntimeTriggerActivationEntity, { where: { id: activationId } });
      const instanceId = row?.composioTriggerInstanceId ?? null;
      if (!instanceId) return null; // nothing subscribed
      // Lock every row sharing this instance id so a sibling teardown waits behind us;
      // `id ASC` orders acquisition to avoid an AB/BA deadlock between two teardowns.
      const holders = await em
        .createQueryBuilder(RuntimeTriggerActivationEntity, 'a')
        .setLock('pessimistic_write')
        .where('a.composio_trigger_instance_id = :instanceId', { instanceId })
        .orderBy('a.id', 'ASC')
        .getMany();
      // Drop OUR reference first, inside the lock, so the next sibling becomes the last holder.
      await em.update(
        RuntimeTriggerActivationEntity,
        { id: activationId },
        { composioTriggerInstanceId: null },
      );
      const othersRemain = holders.some((h) => h.id !== activationId);
      return othersRemain ? null : instanceId; // delete only when we were the last holder
    });
    if (!instanceToDelete) return;
    const scope = await this.platformKeys.scopeForWorkflow(workflowId);
    // Without the owning scope's key we cannot delete it, and we do not try — the reaper
    // reports it instead. Dropping our reference above already stopped it firing here.
    if (scope && (await this.composioTriggers.isConfigured(scope))) {
      await this.composioTriggers.deleteTriggerInstance(scope, instanceToDelete);
    }
  }

  // ─── resolution helpers ───

  /**
   * Classify an IR trigger node into an activation kind, or `null` when it has NO runtime
   * activation — the manual trigger must never become a pollable one.
   */
  private kindOf(node: IRNode): ActivationKind | null {
    if (node.node_type === MANUAL_TRIGGER) return null;
    if (node.node_type === INCOMING_WEBHOOK_PUBLIC) {
      return 'webhook';
    }
    if (node.node_type === INCOMING_CHAT_PUBLIC) return 'chat';
    if (node.node_type === ORCHESTR_SCHEDULE) return 'schedule';
    if (this.sdkWebhooks.isRegisteredWebhook(node.node_type)) return 'registered_webhook';
    if (this.sdkPolling.isPollingTrigger(node.node_type)) return 'polling';
    // The hand-polled Composio-poll exceptions keep OUR poll cycle; everything else
    // `<app>.<trigger>` rides the Composio native-subscription rail (ADR 0046).
    if (composioTriggerSpec(node.node_type)) return 'polling';
    return 'composio_subscription';
  }

  /** Pre-resolve every env slot the desired activations reference, once per (env, app). */
  private async resolveConnections(pointers: EnvPointerInput[]): Promise<Map<string, ConnectionRef | null>> {
    const map = new Map<string, ConnectionRef | null>();
    for (const pointer of pointers) {
      for (const node of pointer.ir.nodes) {
        if (!isTriggerNode(node)) continue;
        const app = validatedAppSlug(node.node_type);
        if (this.isNativeKind(node) || !app) continue;
        // A `none`-scheme SDK polling trigger resolves no connection — skip the slot lookup.
        if (
          this.sdkPolling.isPollingTrigger(node.node_type) &&
          !this.sdkPolling.needsConnection(node.node_type)
        )
          continue;
        const key = slotKey(pointer.environmentId, node);
        if (map.has(key)) continue;
        const slot = await this.connections.resolveSlotConnection(pointer.environmentId, app);
        map.set(key, slot ? { connectionId: slot.id, ownerUserId: slot.ownerUserId } : null);
      }
    }
    return map;
  }

  private isNativeKind(node: IRNode): boolean {
    return (
      node.node_type === INCOMING_WEBHOOK_PUBLIC ||
      node.node_type === INCOMING_CHAT_PUBLIC ||
      node.node_type === ORCHESTR_SCHEDULE
    );
  }

  /**
   * Whether this activation resolves a provider connection. The SDK polling rail is
   * per-trigger, so consult the trigger's own auth scheme rather than assuming by kind.
   */
  private needsConnection(desired: DesiredActivation): boolean {
    if (desired.kind === 'polling' && this.sdkPolling.isPollingTrigger(desired.triggerType)) {
      return this.sdkPolling.needsConnection(desired.triggerType);
    }
    return (
      desired.kind === 'registered_webhook' ||
      desired.kind === 'polling' ||
      desired.kind === 'composio_subscription'
    );
  }

  private slotError(desired: DesiredActivation): string {
    return `No connection in this environment's slot for trigger node ${desired.key.triggerNodeId} — assign one first`;
  }

  private webhookUrl(desired: DesiredActivation, envName: Map<string, string>): string {
    const name = envName.get(desired.key.environmentId) ?? desired.key.environmentId;
    return webhookUrlFor(this.publicBaseUrl(), desired.key.workflowId, name);
  }

  private async loadIrs(versionIds: string[]): Promise<Map<string, WorkflowIR>> {
    const ids = [...new Set(versionIds)];
    const map = new Map<string, WorkflowIR>();
    if (ids.length === 0) return map;
    const rows = await rawQuery<{ id: string; workflow_ir: WorkflowIR | null }>(
      this.dataSource.manager,
      `SELECT id, workflow_ir FROM workflow_versions WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const r of rows) if (r.workflow_ir) map.set(r.id, r.workflow_ir);
    return map;
  }

  private async recordError(activationId: string, err: unknown): Promise<void> {
    const msg = errorMessage(err).slice(0, 1000);
    this.logger.warn(`activation ${activationId}: ${msg}`);
    await this.dataSource.manager
      .update(RuntimeTriggerActivationEntity, { id: activationId }, { lastError: msg })
      .catch(() => undefined);
  }

  private publicBaseUrl(): string {
    const env = this.config.get('env', { infer: true });
    return (env.publicBaseUrl || `http://localhost:${env.port}`).replace(/\/+$/, '');
  }
}

// ─── row ⇄ descriptor mapping + small pure helpers ───

function keyOf(row: RuntimeTriggerActivationEntity): DesiredActivation['key'] {
  return { workflowId: row.workflowId, environmentId: row.environmentId, triggerNodeId: row.triggerNodeId };
}

function connOf(row: RuntimeTriggerActivationEntity): ConnectionRef | null {
  return row.connectionId && row.connectionOwnerUserId
    ? { connectionId: row.connectionId, ownerUserId: row.connectionOwnerUserId }
    : null;
}

/** A materialized row as a descriptor (mirrors `runtime_trigger_activations`). */
function toDesired(row: RuntimeTriggerActivationEntity): ActualActivation {
  return {
    key: keyOf(row),
    kind: row.kind as ActivationKind,
    triggerType: row.triggerType,
    versionId: row.versionId ?? '',
    props: row.props ?? {},
    connection: connOf(row),
    paused: row.paused,
  };
}

function slotKey(environmentId: string, node: IRNode): string {
  return `${environmentId}::${validatedAppSlug(node.node_type) ?? ''}`;
}
