import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Pool } from 'pg';
import { In, Not } from 'typeorm';
import type { DataSource } from 'typeorm';

import { runBounded } from '../../common/bounded';
import { withDeadline } from '../../common/deadline';
import { errorMessage } from '../../common/error-message';
import { ConnectionsService } from '../../connections/connections.service';
import { decideBySlot, type RunAsDecision, type SlotAccount } from '../../connections/run-as-account';
import type { EnvConfig } from '../../config/env.config';
import { newId, now } from '../../database/ids';
import { rawMutate, rawQuery } from '../../database/raw-query';
import { RuntimeTriggerActivationEntity } from '../../database/entities/runtime-trigger-activation.entity';
import { TriggerRetiredWebhookEntity } from '../../database/entities/trigger-retired-webhook.entity';
import { PG_POOL } from '../../database/tokens';
import type { WorkflowIR } from '../../ir/models';
import { ComposioTriggerProvider } from '../../providers/composio-trigger.provider';
import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
} from '../../providers/managed-integration-provider';
import { InMemoryStore, type ProviderStore } from '../../providers/provider-store';
import { SdkPollingProvider } from '../../providers/sdk-polling.provider';
import {
  SdkWebhookProvider,
  WEBHOOK_REGISTRATION_KEY,
  WEBHOOK_SECRET_KEY,
  WebhookCredentialError,
} from '../../providers/sdk-webhook.provider';
import { activationError } from '../activation-error';
import { withActivationLock } from '../activation-lock';
import { DbActivationStore } from '../activation-store';
import {
  legacyRegistrationOf,
  type RegisteredWebhook,
  registeredWebhookOf,
  sameAddress,
  sameRegistration,
  webhookRegistrationOf,
} from '../registered-webhook';
import { SCHEDULE_CURSOR_KEY } from '../schedule';
import { TriggerSignalsService } from '../trigger-signals.service';
import { WebhookDeleteFence } from './webhook-delete-fence';
import { webhookUrlFor } from './webhook-url';
import { activationKeyOf, actualOf } from './activation-row';
import { activationKindOf, listensAsAccount, triggerSlotApp } from './trigger-kind';
import {
  type ActivationKey,
  activationKeyString,
  applyFinished,
  type ConnectionRef,
  type DesiredActivation,
  type MaterializedActivation,
} from './trigger-activation';
import { PlatformKeysService, type PlatformKeyScope } from '../../platform/platform-keys.service';
import {
  deriveDesiredActivations,
  reconcileActivations,
  type ActivationUpdate,
  type EnvPointerInput,
  type ReconcilePlan,
} from './reconcile';
import { lockWorkflowForWrite } from '../../workflows/workflow-row-lock';

/** How long, in ms, a teardown waits on an app's webhook delete before leaving it to a retry. */
export const WEBHOOK_DELETE_WAIT_MS = Symbol('WEBHOOK_DELETE_WAIT_MS');

/** Cap the self-heal re-subscribe fan-out so one slow Composio upsert can't stall the whole sweep. */
const SELFHEAL_CONCURRENCY = 5;

/** One env pointer as reconcile reads it: which version answers, in which env (id + name). */
interface PointerRow {
  environment_id: string;
  environment: string;
  version_id: string;
}

/**
 * The trigger-activation RECONCILER — the definition site of the invariant
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
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(WEBHOOK_DELETE_WAIT_MS) private readonly deleteWaitMs: number,
  ) {}

  /** The last queued reconcile per workflow; absent when none is in flight. In-process only. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Pending deletes queued for a retry or being retried, by id. In-process only. */
  private readonly retrying = new Set<string>();

  /** The queued retries of pending deletes, which run one at a time, apart from every reconcile. */
  private retries: Promise<void> = Promise.resolve();

  private readonly deleteFence = new WebhookDeleteFence();

  /** Wire the inline reconcile path so pointer/slot moves converge even when pg-boss is off. */
  registerInline(): void {
    // Inline reconciles do NOT run the self-heal re-verify pass — that is sweep-only.
    this.signals.registerInline((workflowId) => this.reconcile(workflowId));
  }

  /** Converge one workflow to its desired set from COMMITTED pointers, one reconcile at a time; its pending deletes are then queued for a retry it never waits for. */
  async reconcile(workflowId: string, opts: { selfHeal?: boolean } = {}): Promise<void> {
    const previous = this.tails.get(workflowId) ?? Promise.resolve();
    const run = previous.then(() => this.reconcileOnce(workflowId, opts));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(workflowId, tail);
    try {
      this.queueRetries(await run);
    } finally {
      if (this.tails.get(workflowId) === tail) this.tails.delete(workflowId);
    }
  }

  /** Resolves once every pending delete queued for a retry so far has been retried. */
  async retriesSettled(): Promise<void> {
    await this.retries;
  }

  private async reconcileOnce(
    workflowId: string,
    opts: { selfHeal?: boolean },
  ): Promise<TriggerRetiredWebhookEntity[]> {
    const em = this.dataSource.manager;
    const pendingDeletes = await em.find(TriggerRetiredWebhookEntity, { where: { workflowId } });
    // The env's name comes from its row, as the intake resolves it, never from the pointer's copy of it.
    const pointers = await rawQuery<PointerRow>(
      em,
      `SELECT p.environment_id, e.name AS environment, p.version_id
         FROM workflow_env_pointers p
         JOIN environments e ON e.id = p.environment_id
        WHERE p.workflow_id = $1`,
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
    const slots = await this.resolveSlots(pointerInputs, envNameById);
    const desired = deriveDesiredActivations({
      workflowId,
      pointers: pointerInputs,
      kindOf: (node) => activationKindOf(node.node_type),
      connectionOf: (envId, node) => connectionServing(slots.get(triggerKey(envId, node.id))),
      webhookUrlOf: (envId, kind) =>
        kind === 'registered_webhook'
          ? this.webhookUrl({ workflowId, environmentId: envId }, envNameById)
          : null,
    });

    const actualRows = await em.find(RuntimeTriggerActivationEntity, { where: { workflowId } });
    const rowByKey = new Map(actualRows.map((r) => [activationKeyString(activationKeyOf(r)), r]));
    const actual = actualRows.map((r) => actualOf(r));

    const plan = reconcileActivations(desired, actual);
    // Each op is isolated: a failure lands on the row's `last_error` and never aborts the
    // rest of the sweep — the next reconcile re-converges.
    for (const d of plan.toCreate) {
      await this.applyCreate(d, slots).catch((err) => this.logApplyError('create', d.key, err));
    }
    for (const u of plan.toUpdate) {
      const row = rowByKey.get(activationKeyString(u.actual.key));
      if (row)
        await this.applyUpdate(row, u, envNameById, slots).catch((err) =>
          this.applyFailed('update', row, err),
        );
    }
    for (const d of plan.toDelete) {
      const row = rowByKey.get(activationKeyString(d.key));
      if (row) await this.applyDelete(row, envNameById).catch((err) => this.applyFailed('delete', row, err));
    }
    if (opts.selfHeal) await this.selfHealComposioSubscriptions(desired, rowByKey, plan);
    return pendingDeletes;
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
      if (listensAsAccount(d.kind, d.triggerType) && d.connection === null) continue; // unfilled slot → last_error, not a subscribe
      const keyStr = activationKeyString(d.key);
      if (materialized.has(keyStr)) continue;
      const row = rowByKey.get(keyStr);
      if (!row) continue; // no actual row yet — the next sweep converges it
      targets.push({ id: row.id, desired: d });
    }
    await runBounded(targets, SELFHEAL_CONCURRENCY, ({ id, desired: d }) =>
      withActivationLock(this.pool, id, () => this.standUp(id, d)).catch((err) =>
        this.logApplyError('selfheal', d.key, err),
      ),
    );
  }

  // A failed apply stays visible on its row; the row still disagrees with what is desired, so a later pass applies it again.
  private async applyFailed(op: string, row: RuntimeTriggerActivationEntity, err: unknown): Promise<void> {
    this.logApplyError(op, activationKeyOf(row), err);
    await this.dataSource.manager
      .update(RuntimeTriggerActivationEntity, { id: row.id }, { lastError: activationError(err) })
      .catch((recordErr: unknown) =>
        this.logger.warn(
          `activation ${row.id}: could not record the failed ${op}: ${errorMessage(recordErr)}`,
        ),
      );
  }

  private logApplyError(op: string, key: DesiredActivation['key'], err: unknown): void {
    this.logger.warn(`activation ${op} ${activationKeyString(key)} failed: ${errorMessage(err)}`);
  }

  /** The periodic safety net: reconcile every workflow with an env pointer, an activation or a pending webhook delete. */
  async sweepAll(): Promise<void> {
    const em = this.dataSource.manager;
    const rows = await rawQuery<{ workflow_id: string }>(
      em,
      `SELECT DISTINCT workflow_id FROM workflow_env_pointers WHERE environment_id IS NOT NULL
       UNION
       SELECT DISTINCT workflow_id FROM runtime_trigger_activations
       UNION
       SELECT DISTINCT workflow_id FROM trigger_retired_webhooks`,
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

  /** Queue a reconcile of every workflow with an activation whose last apply did not finish (a poll passes it over) or whose webhook is registered at a URL no longer served (a new public base URL). */
  async reconcileStale(): Promise<void> {
    const em = this.dataSource.manager;
    const rows = await em.find(RuntimeTriggerActivationEntity);
    const envNames = new Map(
      (await rawQuery<{ id: string; name: string }>(em, `SELECT id, name FROM environments`)).map((e) => [
        e.id,
        e.name,
      ]),
    );
    const moved = (r: RuntimeTriggerActivationEntity): boolean =>
      r.kind === 'registered_webhook' && r.webhookUrl !== this.webhookUrl(activationKeyOf(r), envNames);
    const stale = rows.filter((r) => !applyFinished(actualOf(r)) || moved(r));
    for (const workflowId of new Set(stale.map((r) => r.workflowId))) await this.signals.enqueue(workflowId);
  }

  // ─── apply ───

  private async applyCreate(desired: DesiredActivation, slots: SlotDecisions): Promise<void> {
    const id = newId();
    const ts = now();
    const missingSlot = listensAsAccount(desired.kind, desired.triggerType) && desired.connection === null;
    const standsUp = !missingSlot && !desired.paused;
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
      webhookUrl: desired.webhookUrl,
      lastPolledAt: null,
      lastError: missingSlot ? slotError(desired, slots) : null,
      createdAt: ts,
      updatedAt: ts,
      // Paused or unslotted stands nothing up, so that much is already in effect.
      materialized: standsUp ? null : materializedOf(desired),
    });
    await withActivationLock(this.pool, id, async () => {
      await this.dataSource.transaction(async (em) => {
        await lockWorkflowForWrite(em, desired.key.workflowId);
        await em.save(RuntimeTriggerActivationEntity, row);
      });
      if (standsUp) await this.standUp(id, desired);
    });
  }

  private async applyUpdate(
    row: RuntimeTriggerActivationEntity,
    update: ActivationUpdate,
    envName: Map<string, string>,
    slots: SlotDecisions,
  ): Promise<void> {
    const { desired } = update;
    const live = liveOf(row);
    const missingSlot = listensAsAccount(desired.kind, desired.triggerType) && desired.connection === null;
    row.kind = desired.kind;
    row.triggerType = desired.triggerType;
    row.versionId = desired.versionId;
    row.props = desired.props;
    row.connectionId = desired.connection?.connectionId ?? null;
    row.connectionOwnerUserId = desired.connection?.ownerUserId ?? null;
    row.paused = desired.paused;
    row.webhookUrl = desired.webhookUrl;
    row.lastError = missingSlot ? slotError(desired, slots) : null;
    row.updatedAt = now();
    await withActivationLock(this.pool, row.id, async () => {
      await this.dataSource.manager.save(RuntimeTriggerActivationEntity, row);
      // A 'keep' leaves the cursor/subscription untouched; a 'reset' tears down what is live and starts from now.
      if (update.cursorAction === 'keep') return;
      await this.teardown(row, live, envName);
      if (desired.paused || missingSlot) {
        await this.recordMaterialized(row.id, desired);
        return;
      }
      await this.standUp(row.id, desired);
    });
  }

  private async applyDelete(
    row: RuntimeTriggerActivationEntity,
    envName: Map<string, string>,
  ): Promise<void> {
    await withActivationLock(this.pool, row.id, async () => {
      await this.teardown(row, liveOf(row), envName);
      await this.dataSource.manager.delete(RuntimeTriggerActivationEntity, { id: row.id }); // store cascades
    });
  }

  private async standUp(activationId: string, desired: DesiredActivation): Promise<void> {
    try {
      await this.materialize(activationId, desired);
    } catch (err) {
      await this.recordError(activationId, err);
      return;
    }
    await this.recordMaterialized(activationId, desired);
  }

  private async recordMaterialized(activationId: string, desired: DesiredActivation): Promise<void> {
    await rawMutate(
      this.dataSource.manager,
      `UPDATE runtime_trigger_activations SET materialized = CAST($2 AS jsonb) WHERE id = $1`,
      [activationId, JSON.stringify(materializedOf(desired))],
    );
  }

  // ─── provider materialization / teardown (per kind) ───

  /** Stand up the live side-effect for an activation; throws so the caller records the failure. */
  private async materialize(activationId: string, desired: DesiredActivation): Promise<void> {
    const store = new DbActivationStore(this.dataSource, activationId);
    switch (desired.kind) {
      case 'schedule':
        await store.put(SCHEDULE_CURSOR_KEY, now().toISOString());
        return;
      case 'registered_webhook':
        await this.registerWebhook(activationId, desired);
        return;
      case 'polling':
        // A discarded seed primes the dedup watermark; until one succeeds the poll cycle passes the activation over.
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
        return; // ditto
    }
  }

  // Tears down what `live` stood up, and any webhook the store records whatever `live` says, then empties the store.
  private async teardown(
    row: RuntimeTriggerActivationEntity,
    live: MaterializedActivation,
    envName: Map<string, string>,
  ): Promise<void> {
    const store = new DbActivationStore(this.dataSource, row.id);
    await this.unregisterWebhook(row, live, store, envName);
    if (live.kind === 'polling' && !this.sdkPolling.isPollingTrigger(live.triggerType)) {
      // SDK polling holds no remote subscription; only the hand-polled Composio-poll rail has a disable.
      await this.lifecycle.disableTrigger({
        externalUserId: live.connection?.ownerUserId ?? '',
        triggerId: live.triggerType,
        props: live.props,
        auth: live.connection ? { connectionId: live.connection.connectionId } : undefined,
        store,
      });
    } else if (live.kind === 'composio_subscription') {
      await this.unsubscribeComposio(row.id, row.workflowId);
    }
    await store.clear();
  }

  private async unregisterWebhook(
    row: RuntimeTriggerActivationEntity,
    live: MaterializedActivation,
    store: DbActivationStore,
    envName: Map<string, string>,
  ): Promise<void> {
    const stored = await store.get<unknown>(WEBHOOK_REGISTRATION_KEY);
    if (stored === null) return;
    const webhook =
      registeredWebhookOf(stored) ?? (await this.legacyWebhook(row, live, stored, store, envName));
    if (!webhook || (await this.registrationHeld(webhook, row.id))) return;
    await this.boundedDelete(webhook).then(
      () => this.noteUnreportedDelete(webhook, row.workflowId),
      (err: unknown) => this.retire(row, webhook, err),
    );
  }

  // A delete still running past the wait stays in the fence, so a stand-up handed its handle waits for it to land.
  private boundedDelete(webhook: RegisteredWebhook): Promise<void> {
    const attempt = this.deleteFence.deleting(webhook, () =>
      this.disableWebhook(webhook, new InMemoryStore()),
    );
    return withDeadline(
      attempt,
      this.deleteWaitMs,
      () => new Error(`the app did not answer the delete within ${this.deleteWaitMs}ms`),
    );
  }

  // The log is the only record of a webhook whose app may have kept it without saying so.
  private noteUnreportedDelete(webhook: RegisteredWebhook, workflowId: string): void {
    if (this.sdkWebhooks.reportsFailedDelete(webhook.triggerType)) return;
    this.logger.warn(
      `${webhookLabel(webhook)} at ${webhook.webhookUrl} of workflow ${workflowId} was deleted, but its app does not ` +
        `report a failed delete — if it is still there, delete it in the app`,
    );
  }

  // A bare handle an earlier release stored names no trigger type; only a row still live as a registered webhook supplies one.
  private async legacyWebhook(
    row: RuntimeTriggerActivationEntity,
    live: MaterializedActivation,
    stored: unknown,
    store: DbActivationStore,
    envName: Map<string, string>,
  ): Promise<RegisteredWebhook | null> {
    const registration = legacyRegistrationOf(stored);
    if (!registration || live.kind !== 'registered_webhook') {
      const hook = registration ? `webhook ${registration.subscriptionId}` : 'a webhook';
      this.logger.warn(
        `activation ${row.id} (workflow ${row.workflowId}): ${hook} registered by an earlier release does not ` +
          `record its trigger, so it cannot be deleted from here — delete it in the app`,
      );
      return null;
    }
    return {
      triggerType: live.triggerType,
      props: live.props,
      connection: live.connection,
      webhookUrl: this.webhookUrl(activationKeyOf(row), envName),
      secret: (await store.get<string>(WEBHOOK_SECRET_KEY)) ?? '',
      registration,
    };
  }

  private disableWebhook(webhook: RegisteredWebhook, store: ProviderStore): Promise<void> {
    return this.sdkWebhooks.disable({
      externalUserId: webhook.connection?.ownerUserId ?? '',
      type: webhook.triggerType,
      props: webhook.props,
      auth: webhook.connection ? { connectionId: webhook.connection.connectionId } : null,
      store,
      webhookUrl: webhook.webhookUrl,
      secret: webhook.secret,
      registration: webhook.registration,
    });
  }

  // The activation carries on as if the delete had succeeded; only a retry after its stand-up, which may take the webhook over, gives it up.
  private async retire(
    row: RuntimeTriggerActivationEntity,
    webhook: RegisteredWebhook,
    err: unknown,
  ): Promise<void> {
    if (!(err instanceof WebhookCredentialError)) {
      this.logger.warn(
        `activation ${row.id}: ${webhookLabel(webhook)} delete failed, retried by later reconciles: ${errorMessage(err)}`,
      );
    }
    const em = this.dataSource.manager;
    const ts = now();
    const entry = em.create(TriggerRetiredWebhookEntity, {
      id: newId(),
      workflowId: row.workflowId,
      environmentId: row.environmentId,
      triggerNodeId: row.triggerNodeId,
      webhook,
      lastError: errorMessage(err),
      createdAt: ts,
      updatedAt: ts,
    });
    await em.save(TriggerRetiredWebhookEntity, entry);
  }

  private queueRetries(entries: TriggerRetiredWebhookEntity[]): void {
    const queued = entries.filter((entry) => !this.retrying.has(entry.id));
    if (queued.length === 0) return;
    for (const entry of queued) this.retrying.add(entry.id);
    this.retries = this.retries.then(() => this.retryRetiredWebhooks(queued));
  }

  private async retryRetiredWebhooks(entries: TriggerRetiredWebhookEntity[]): Promise<void> {
    for (const entry of entries) {
      await this.retryRetiredWebhook(entry)
        .catch((err: unknown) =>
          this.logger.warn(`pending webhook delete ${entry.id} was not retried: ${errorMessage(err)}`),
        )
        .finally(() => this.retrying.delete(entry.id));
    }
  }

  private async retryRetiredWebhook(entry: TriggerRetiredWebhookEntity): Promise<void> {
    const em = this.dataSource.manager;
    if ((await em.count(TriggerRetiredWebhookEntity, { where: { id: entry.id } })) === 0) return;
    const done = await this.deleteFence.deleting(
      entry.webhook,
      async () => (await this.registrationHeld(entry.webhook)) || (await this.retriedDelete(entry)),
    );
    if (done) await em.delete(TriggerRetiredWebhookEntity, { id: entry.id });
  }

  // Whether the entry is done with: deleted, or never deletable. The activation's store now belongs to its successor.
  private async retriedDelete(entry: TriggerRetiredWebhookEntity): Promise<boolean> {
    try {
      await this.disableWebhook(entry.webhook, new InMemoryStore());
      this.noteUnreportedDelete(entry.webhook, entry.workflowId);
      return true;
    } catch (err) {
      if (err instanceof WebhookCredentialError) {
        this.abandon(entry.webhook, entry.workflowId, err);
        return true;
      }
      this.logger.warn(`retried ${webhookLabel(entry.webhook)} delete failed: ${errorMessage(err)}`);
      await this.dataSource.manager.update(
        TriggerRetiredWebhookEntity,
        { id: entry.id },
        { lastError: errorMessage(err), updatedAt: now() },
      );
      return false;
    }
  }

  // An app that upserts (Typeform's per-URL tag) hands a new registration an old one's handle; deleting it would take the new one down.
  private async registrationHeld(webhook: RegisteredWebhook, exceptActivationId?: string): Promise<boolean> {
    const rows = await rawQuery<{ trigger_type: string; value: unknown }>(
      this.dataSource.manager,
      `SELECT a.trigger_type, s.value
         FROM runtime_activation_store s
         JOIN runtime_trigger_activations a ON a.id = s.activation_id
        WHERE s.key = $1
          AND COALESCE(s.value -> 'registration' ->> 'subscriptionId', s.value ->> 'subscriptionId') = $2
          AND ($3::uuid IS NULL OR s.activation_id <> $3::uuid)`,
      [WEBHOOK_REGISTRATION_KEY, webhook.registration.subscriptionId, exceptActivationId ?? null],
    );
    return rows.some(({ trigger_type, value }) => {
      const registration = webhookRegistrationOf(value);
      const triggerType = registeredWebhookOf(value)?.triggerType ?? trigger_type;
      return registration !== null && sameRegistration(webhook, { triggerType, registration });
    });
  }

  private async forgetRetiredHeldBy(webhook: RegisteredWebhook): Promise<void> {
    const em = this.dataSource.manager;
    const entries = await rawQuery<{ id: string; webhook: RegisteredWebhook }>(
      em,
      `SELECT id, webhook FROM trigger_retired_webhooks WHERE webhook -> 'registration' ->> 'subscriptionId' = $1`,
      [webhook.registration.subscriptionId],
    );
    const held = entries.filter((entry) => sameRegistration(entry.webhook, webhook)).map((entry) => entry.id);
    if (held.length > 0) await em.delete(TriggerRetiredWebhookEntity, { id: In(held) });
  }

  private abandon(webhook: RegisteredWebhook, workflowId: string, err: WebhookCredentialError): void {
    this.logger.warn(
      `${webhookLabel(webhook)} of workflow ${workflowId} can never be deleted with the account that registered it ` +
        `(${err.message}), so it is left in the app — delete it there`,
    );
  }

  /** Register a fresh provider subscription pointing at the per-(workflow,env) intake URL. */
  private async registerWebhook(activationId: string, desired: DesiredActivation): Promise<void> {
    const register = (): Promise<void> =>
      this.deleteFence.standUp(() => this.registerWebhookOnce(activationId, desired));
    try {
      await register();
    } catch (err) {
      // An app that refuses a second webhook at one URL (GitHub, Calendly) refuses this one while a pending delete's is there.
      if (!(await this.landPendingDeletesAt(desired))) throw err;
      await register();
    }
  }

  // Whether a pending delete of a webhook at the desired address was there and landed within the wait; other retries are never waited on.
  private async landPendingDeletesAt(desired: DesiredActivation): Promise<boolean> {
    const { webhookUrl } = desired;
    if (!webhookUrl) return false;
    const target = { triggerType: desired.triggerType, webhookUrl };
    const atAddress = async (): Promise<TriggerRetiredWebhookEntity[]> =>
      (
        await this.dataSource.manager.find(TriggerRetiredWebhookEntity, {
          where: { workflowId: desired.key.workflowId },
        })
      ).filter((entry) => sameAddress(entry.webhook, target));
    if ((await atAddress()).length === 0) return false;
    // One already being deleted lands through the fence; the rest are deleted now, so their queued copies find them gone.
    const landing = (async (): Promise<void> => {
      await this.deleteFence.landed((webhook) => sameAddress(webhook, target));
      for (const entry of await atAddress()) await this.retryRetiredWebhook(entry);
    })();
    const inTime = await withDeadline(
      landing,
      this.deleteWaitMs,
      () => new Error('a pending delete at this address is still running'),
    ).then(
      () => true,
      () => false,
    );
    return inTime && (await atAddress()).length === 0;
  }

  private async registerWebhookOnce(
    activationId: string,
    desired: DesiredActivation,
  ): Promise<RegisteredWebhook | null> {
    const { webhookUrl } = desired;
    if (!webhookUrl) throw new Error(`No intake URL resolved for ${desired.triggerType}`);
    const store = new DbActivationStore(this.dataSource, activationId);
    const secret = randomBytes(32).toString('hex');
    await store.put(WEBHOOK_SECRET_KEY, secret);
    const registration = await this.sdkWebhooks.enable({
      externalUserId: desired.connection?.ownerUserId ?? '',
      type: desired.triggerType,
      props: desired.props,
      store,
      webhookUrl,
      secret,
      auth: desired.connection ? { connectionId: desired.connection.connectionId } : null,
    });
    if (!registration) return null;
    const webhook: RegisteredWebhook = {
      triggerType: desired.triggerType,
      props: desired.props,
      connection: desired.connection,
      webhookUrl,
      secret,
      registration,
    };
    await store.put(WEBHOOK_REGISTRATION_KEY, webhook);
    await this.forgetRetiredHeldBy(webhook);
    return webhook;
  }

  /**
   * Subscribe a Composio trigger INSTANCE for this activation and persist its id
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
   * Tear down this activation's Composio subscription. REFCOUNTED: activations
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
      await this.composioTriggers
        .deleteTriggerInstance(scope, instanceToDelete)
        .catch((err) =>
          this.logger.warn(
            `delete of ${instanceToDelete} failed, left to the orphan reaper: ${errorMessage(err)}`,
          ),
        );
    }
  }

  // ─── resolution helpers ───

  /** Each trigger node's slot under each env pointer, read once per (env, app) and judged by the run-as slot rule (#18). */
  private async resolveSlots(
    pointers: EnvPointerInput[],
    envNameById: Map<string, string>,
  ): Promise<SlotDecisions> {
    const reads = new Map<string, Promise<SlotAccount | null>>();
    const decisions: SlotDecisions = new Map();
    for (const pointer of pointers) {
      const environment = envNameById.get(pointer.environmentId) ?? 'This environment';
      for (const node of pointer.ir.nodes) {
        const app = triggerSlotApp(node);
        if (!app) continue;
        const readKey = `${pointer.environmentId}::${app}`;
        const read = reads.get(readKey) ?? this.connections.resolveSlotConnection(pointer.environmentId, app);
        reads.set(readKey, read);
        const trigger = { name: node.name || node.id, app, connectionId: null };
        const decision = await decideBySlot(trigger, await read, () => Promise.resolve(environment));
        decisions.set(triggerKey(pointer.environmentId, node.id), decision);
      }
    }
    return decisions;
  }

  private webhookUrl(
    key: Pick<ActivationKey, 'workflowId' | 'environmentId'>,
    envName: Map<string, string>,
  ): string {
    const name = envName.get(key.environmentId) ?? key.environmentId;
    return webhookUrlFor(this.publicBaseUrl(), key.workflowId, name);
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
    // The operator gets the error as thrown; the row carries the copy the user reads.
    this.logger.warn(`activation ${activationId}: ${errorMessage(err)}`);
    await this.dataSource.manager.update(
      RuntimeTriggerActivationEntity,
      { id: activationId },
      { lastError: activationError(err) },
    );
  }

  private publicBaseUrl(): string {
    const env = this.config.get('env', { infer: true });
    return (env.publicBaseUrl || `http://localhost:${env.port}`).replace(/\/+$/, '');
  }
}

// ─── row ⇄ descriptor mapping + small pure helpers ───

function materializedOf(a: MaterializedActivation): MaterializedActivation {
  return {
    kind: a.kind,
    triggerType: a.triggerType,
    props: a.props,
    connection: a.connection,
    paused: a.paused,
    webhookUrl: a.webhookUrl,
  };
}

// Read before the row is overwritten; a row with nothing recorded is best guessed by its own columns.
function liveOf(row: RuntimeTriggerActivationEntity): MaterializedActivation {
  const actual = actualOf(row);
  return actual.materialized ?? materializedOf(actual);
}

// The props locate the hook in the app (a GitHub hook id exists only under its repository).
function webhookLabel(webhook: RegisteredWebhook): string {
  const where = Object.entries(webhook.props)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key} ${String(value)}`)
    .sort((a, b) => a.localeCompare(b));
  const label = `${webhook.triggerType} webhook ${webhook.registration.subscriptionId}`;
  return where.length > 0 ? `${label} (${where.join(', ')})` : label;
}

type SlotDecisions = Map<string, RunAsDecision>;

function triggerKey(environmentId: string, triggerNodeId: string): string {
  return `${environmentId}::${triggerNodeId}`;
}

// A trigger listens as its slot's account only while the slot serves it; otherwise as none, and stands nothing up.
function connectionServing(decision: RunAsDecision | undefined): ConnectionRef | null {
  return decision?.kind === 'account'
    ? { connectionId: decision.connectionId, ownerUserId: decision.ownerUserId }
    : null;
}

function slotError(desired: DesiredActivation, slots: SlotDecisions): string {
  const decision = slots.get(triggerKey(desired.key.environmentId, desired.key.triggerNodeId));
  return decision?.kind === 'refused'
    ? decision.message
    : `No connection in this environment's slot for trigger node ${desired.key.triggerNodeId} — assign one first`;
}
