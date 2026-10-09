import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Pool } from 'pg';
import { In, Not } from 'typeorm';
import type { DataSource } from 'typeorm';

import { runBounded } from '../../common/bounded';
import { errorMessage } from '../../common/error-message';
import { isTriggerNode } from '../../compiler/compile-ir';
import { ConnectionsService } from '../../connections/connections.service';
import type { EnvConfig } from '../../config/env.config';
import { newId, now } from '../../database/ids';
import { rawMutate, rawQuery } from '../../database/raw-query';
import { RuntimeTriggerActivationEntity } from '../../database/entities/runtime-trigger-activation.entity';
import { TriggerRetiredWebhookEntity } from '../../database/entities/trigger-retired-webhook.entity';
import { PG_POOL } from '../../database/tokens';
import type { IRNode, WorkflowIR } from '../../ir/models';
import { composioTriggerSpec } from '../../providers/composio-trigger.registry';
import { ComposioTriggerProvider } from '../../providers/composio-trigger.provider';
import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
} from '../../providers/managed-integration-provider';
import { InMemoryStore, type ProviderStore } from '../../providers/provider-store';
import { validatedAppSlug } from '../../providers/sdk-actions.registry';
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
  sameRegistration,
  webhookRegistrationOf,
} from '../registered-webhook';
import {
  AGENT_TOOL_PUBLIC,
  INCOMING_CHAT_PUBLIC,
  INCOMING_WEBHOOK_PUBLIC,
  MANUAL_TRIGGER,
} from '../trigger-catalog.service';
import { ORCHESTR_SCHEDULE, SCHEDULE_CURSOR_KEY } from '../schedule';
import { TriggerSignalsService } from '../trigger-signals.service';
import { WebhookDeleteFence } from './webhook-delete-fence';
import { webhookUrlFor } from './webhook-url';
import { activationKeyOf, actualOf } from './activation-row';
import {
  type ActivationKey,
  activationKeyString,
  type ActivationKind,
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
      // Only a registered webhook hands its intake URL to a provider.
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
      await this.applyCreate(d).catch((err) => this.logApplyError('create', d.key, err));
    }
    for (const u of plan.toUpdate) {
      const row = rowByKey.get(activationKeyString(u.actual.key));
      if (row)
        await this.applyUpdate(row, u, envNameById).catch((err) =>
          this.logApplyError('update', u.desired.key, err),
        );
    }
    for (const d of plan.toDelete) {
      const row = rowByKey.get(activationKeyString(d.key));
      if (row)
        await this.applyDelete(row, envNameById).catch((err) => this.logApplyError('delete', d.key, err));
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
      if (this.needsConnection(d) && d.connection === null) continue; // unfilled slot → last_error, not a subscribe
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

  /** Queue a reconcile of every workflow with an activation whose last apply did not finish, which a poll passes over. */
  async reconcileUnfinished(): Promise<void> {
    const rows = await this.dataSource.manager.find(RuntimeTriggerActivationEntity);
    const workflowIds = new Set(rows.filter((r) => !applyFinished(actualOf(r))).map((r) => r.workflowId));
    for (const workflowId of workflowIds) await this.signals.enqueue(workflowId);
  }

  // ─── apply ───

  private async applyCreate(desired: DesiredActivation): Promise<void> {
    const id = newId();
    const ts = now();
    const missingSlot = this.needsConnection(desired) && desired.connection === null;
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
      lastError: missingSlot ? this.slotError(desired) : null,
      createdAt: ts,
      updatedAt: ts,
      // Paused or unslotted stands nothing up, so that much is already in effect.
      materialized: standsUp ? null : materializedOf(desired),
    });
    await withActivationLock(this.pool, id, async () => {
      await this.dataSource.manager.save(RuntimeTriggerActivationEntity, row);
      if (standsUp) await this.standUp(id, desired);
    });
  }

  private async applyUpdate(
    row: RuntimeTriggerActivationEntity,
    update: ActivationUpdate,
    envName: Map<string, string>,
  ): Promise<void> {
    const { desired } = update;
    const live = liveOf(row);
    const missingSlot = this.needsConnection(desired) && desired.connection === null;
    row.kind = desired.kind;
    row.triggerType = desired.triggerType;
    row.versionId = desired.versionId;
    row.props = desired.props;
    row.connectionId = desired.connection?.connectionId ?? null;
    row.connectionOwnerUserId = desired.connection?.ownerUserId ?? null;
    row.paused = desired.paused;
    row.webhookUrl = desired.webhookUrl;
    row.lastError = missingSlot ? this.slotError(desired) : null;
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
    await this.disableWebhook(webhook, store).catch((err: unknown) => this.retire(row, webhook, err));
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
    const done = await this.deleteFence.deleting(
      entry.webhook,
      async () => (await this.registrationHeld(entry.webhook)) || (await this.retriedDelete(entry)),
    );
    if (done) await this.dataSource.manager.delete(TriggerRetiredWebhookEntity, { id: entry.id });
  }

  // Whether the entry is done with: deleted, or never deletable. The activation's store now belongs to its successor.
  private async retriedDelete(entry: TriggerRetiredWebhookEntity): Promise<boolean> {
    try {
      await this.disableWebhook(entry.webhook, new InMemoryStore());
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
  private registerWebhook(activationId: string, desired: DesiredActivation): Promise<void> {
    return this.deleteFence.standUp(() => this.registerWebhookOnce(activationId, desired));
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

  /**
   * Classify an IR trigger node into an activation kind, or `null` when it has NO runtime
   * activation — the manual trigger must never become a pollable one.
   */
  private kindOf(node: IRNode): ActivationKind | null {
    // Neither fires on its own: the manual trigger waits for a Run, the tool trigger for a caller
    // . Without this a tool trigger falls through to the Composio rail and asks for a
    // connection slot it can never have.
    if (node.node_type === MANUAL_TRIGGER || node.node_type === AGENT_TOOL_PUBLIC) return null;
    if (node.node_type === INCOMING_WEBHOOK_PUBLIC) {
      return 'webhook';
    }
    if (node.node_type === INCOMING_CHAT_PUBLIC) return 'chat';
    if (node.node_type === ORCHESTR_SCHEDULE) return 'schedule';
    if (this.sdkWebhooks.isRegisteredWebhook(node.node_type)) return 'registered_webhook';
    if (this.sdkPolling.isPollingTrigger(node.node_type)) return 'polling';
    // The hand-polled Composio-poll exceptions keep OUR poll cycle; everything else
    // `<app>.<trigger>` rides the Composio native-subscription rail.
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

function slotKey(environmentId: string, node: IRNode): string {
  return `${environmentId}::${validatedAppSlug(node.node_type) ?? ''}`;
}
