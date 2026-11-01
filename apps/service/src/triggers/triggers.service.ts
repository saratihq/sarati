import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Pool } from 'pg';
import { In, IsNull } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import type { Principal } from '../auth/principal';
import { runBounded } from '../common/bounded';
import { withDeadline } from '../common/deadline';
import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { isRecord } from '../common/json-util';
import { ShuttingDown } from '../common/shutdown-deadline';
import type { EnvConfig } from '../config/env.config';
import { ConnectionsService } from '../connections/connections.service';
import { isIdShape, nameBasedId, newId, now } from '../database/ids';
import { rawMutate, rawQuery } from '../database/raw-query';
import { ComposioWebhookDeliveryEntity } from '../database/entities/composio-webhook-delivery.entity';
import { EnvironmentEntity } from '../database/entities/environment.entity';
import { RuntimeTriggerActivationEntity } from '../database/entities/runtime-trigger-activation.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { PG_POOL } from '../database/tokens';
import { canonicalEnvName } from '../environments/env-name';
import { EnvironmentsService } from '../environments/environments.service';
import { deepEqual, type IRNode, type WorkflowIR } from '../ir/models';
import { activationError } from './activation-error';
import { ifActivationUnlocked } from './activation-lock';
import { ADMISSION_EPOCH_KEY, DbActivationStore, HeldWritesStore } from './activation-store';
import { actualOf, holdsTrigger, triggerOf } from './canvas/activation-row';
import { type ActivationKind, applyFinished, triggerPropsOf } from './canvas/trigger-activation';
import { firesWhileHeld, heldBackBySlot } from './canvas/trigger-kind';
import { servedWebhookUrl } from './canvas/webhook-url';
import { webhookRegistrationOf } from './registered-webhook';
import { EnvPointersService, PROD_ENV } from '../workflows/env-pointers.service';
import { ComposioTriggerProvider } from '../providers/composio-trigger.provider';
import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
  type TriggerEvent,
} from '../providers/managed-integration-provider';
import type { ProviderStore } from '../providers/provider-store';
import { SdkPollingProvider } from '../providers/sdk-polling.provider';
import {
  SdkWebhookProvider,
  WEBHOOK_REGISTRATION_KEY,
  WEBHOOK_SECRET_KEY,
} from '../providers/sdk-webhook.provider';
import { AgentStepBus, channelKey } from '../runtime/agent-step-bus';
import type { DagPlan } from '../runtime/dag-plan';
import { RuntimeCompiler } from '../runtime/runtime-compiler';
import { type AdmittedRun, isRunExists, type RunDispatchOptions, RunsService } from '../runs/runs.service';
import { extractChatReply } from '../runtime/terminal-output';
import { SCHEDULE_CURSOR_KEY, dueAt, parseScheduleProps } from './schedule';
import {
  INCOMING_CHAT_PUBLIC,
  INCOMING_WEBHOOK_PUBLIC,
  TriggerCatalogService,
} from './trigger-catalog.service';
import { WebhookSecretsService } from './webhook-secrets.service';
import { verifyWebhookSignature, type WebhookVerification } from './webhook-verify';
import { WorkflowAccessService } from '../workflows/workflow-access.service';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';

/** One inbound delivery as the public intake sees it (raw bytes + headers required for HMAC verify). */
export interface InboundWebhook {
  body: unknown;
  /** The body's bytes as sent, once any Content-Encoding is undone — what every signature is checked over. */
  rawBody: Buffer;
  headers: Record<string, string>;
}

/** One inbound chat message as the synchronous chat intake sees it. */
export interface InboundChat {
  /** The user's message — the run reads it as `{{trigger.chatInput}}`. */
  chatInput: string;
  /** Conversation key: client-supplied when continuing a thread, else server-minted. */
  sessionId?: string;
  /** Optional client action hint (button id, quick-reply). Surfaces as `{{trigger.action}}`. */
  action?: string;
}

/** The synchronous chat reply the intake returns in the same HTTP response. */
export interface ChatReply {
  runId: string;
  sessionId: string;
  /** The terminal node's output (unknown shape) — see {@link extractChatReply}. */
  reply: unknown;
  /** Every executed node's output, keyed by node id (the full run scope). */
  outputs: Record<string, unknown>;
}

/** How long the chat intake awaits its run before returning 504 — the run itself keeps going. */
const CHAT_RUN_TIMEOUT_MS = 30_000;

/** Canvas-trigger ACTIVATION kinds the poll cycle drives. */
const ORCHESTR_SCHEDULE_KIND = 'schedule';
const POLLING_KIND = 'polling';

interface ActivationTarget {
  wf: WorkflowEntity;
  env: EnvironmentEntity;
  versionId: string;
  ir: WorkflowIR;
}

/** Composio orphan reaper (backstop): run at the sweep cadence, not every poll tick. */
const COMPOSIO_REAP_INTERVAL_MS = 15 * 60_000;
/** How long a claimed `webhook-id` is remembered — must outlast any provider retry window. */
const COMPOSIO_DELIVERY_TTL_DAYS = 7;
/** Prune the delivery ledger at most this often — it is housekeeping, not hot path. */
const COMPOSIO_DELIVERY_PRUNE_INTERVAL_MS = 60 * 60_000;
/** Cap the reaper's best-effort deletes so a slow Composio call can't stall the poll cycle. */
const COMPOSIO_REAP_CONCURRENCY = 5;

/** One canvas-trigger activation's runtime health, read off its `runtime_trigger_activations` row. */
export interface ActivationHealth {
  /** The promoted env this activation runs under — canonical name (e.g. `production`). */
  environment: string;
  environment_id: string;
  /** Public trigger type (`orchestr:webhook`, `orchestr:schedule`, `rss.new-item`, …). */
  trigger_type: string;
  kind: ActivationKind;
  /** `false` only when an operator paused it (desired-present but not firing). */
  active: boolean;
  /** Held back or held by its environment's slot, so nothing is stood up, polled or changed at its app for it; `last_error` says why and what fixes it. */
  held_back_by_slot: boolean;
  /** Whether it takes events now: not while paused, held back or its last stand-up unfinished, and while held only a webhook or subscription the version its environment points at still holds as it is live, a webhook registered at the intake served for it, which a delivery reaches by path alone. */
  listening: boolean;
  status: 'paused' | 'error' | 'ok' | 'idle';
  last_polled_at: string | null;
  last_error: string | null;
  updated_at: string | null;
}

/**
 * The canvas-trigger FIRE + READ surface: webhook/chat intake, activation
 * poll cycle, trigger catalog, activation health. Reconciliation lives in the reconciler.
 */
@Injectable()
export class TriggersService {
  private readonly logger = new Logger(TriggersService.name);
  /** Orphan-reaper throttle: last wall-clock ms the reaper ran (0 = never). */
  private lastComposioReapAt = 0;
  /** Two-strike grace: instance ids seen orphaned on the PREVIOUS reap pass (see the reaper). */
  private composioOrphanCandidates = new Set<string>();
  private nextComposioOrphanCandidates = new Set<string>();
  /** Delivery-ledger prune throttle: last wall-clock ms the TTL delete ran (0 = never). */
  private lastComposioDeliveryPruneAt = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(MANAGED_INTEGRATION_PROVIDER) private readonly lifecycle: ManagedIntegrationProvider,
    private readonly sdkWebhooks: SdkWebhookProvider,
    private readonly sdkPolling: SdkPollingProvider,
    private readonly composioTriggers: ComposioTriggerProvider,
    private readonly runs: RunsService,
    private readonly envPointers: EnvPointersService,
    private readonly environments: EnvironmentsService,
    private readonly access: WorkflowAccessService,
    private readonly compiler: RuntimeCompiler,
    private readonly webhookSecrets: WebhookSecretsService,
    private readonly connections: ConnectionsService,
    private readonly agentStepBus: AgentStepBus,
    private readonly triggerCatalog: TriggerCatalogService,
    private readonly platformKeys: PlatformKeysService,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** The trigger palette for the client's canvas picker — served verbatim from the one trigger source. */
  async catalog(scope: PlatformKeyScope): Promise<Array<Record<string, unknown>>> {
    return (await this.triggerCatalog.list(scope)).map((row) => row.entry);
  }

  /**
   * Per-`(workflow, env)` webhook intake: resolve the env pointer → PINNED
   * version → its webhook node, and fire ONLY that version. Inert (404) when unpromoted.
   */
  async fireWorkflowEnvWebhook(
    workflowId: string,
    environmentName: string,
    inbound: InboundWebhook,
  ): Promise<{ runIds: string[] }> {
    const em = this.dataSource.manager;
    if (!isIdShape(workflowId)) throw new DomainError('Webhook not found', 404);
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    if (!wf) throw new DomainError('Webhook not found', 404);
    const resolved = await this.resolveEnvVersion(em, wf, environmentName);
    if (!resolved) throw new DomainError('Webhook not found', 404);
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: resolved.versionId } });
    const ir = version?.workflowIr as unknown as WorkflowIR | undefined;
    const node = ir ? this.findInboundWebhookNode(ir) : null;
    if (!ir || !node) throw new DomainError('Webhook not found', 404);

    // A registered-webhook node MUST route to the SDK's handleRequest — the native path
    // below skips its signature verify, envelope transform, and retry dedupe.
    if (this.sdkWebhooks.isRegisteredWebhook(node.node_type)) {
      return this.fireRegisteredWebhookDelivery(wf, resolved, ir, node, inbound);
    }

    // HMAC verification: enforced ONLY when both a verification config and a
    // stored env-scoped secret exist — an unconfigured webhook keeps the unguessable-path model.
    const verification = (node.parameters as { verification?: WebhookVerification } | undefined)
      ?.verification;
    if (verification && (verification.preset || verification.header)) {
      const secret = await this.webhookSecrets.getSecret(workflowId, resolved.environmentId, node.id);
      if (secret && !verifyWebhookSignature(verification, inbound.rawBody, inbound.headers, secret)) {
        throw new DomainError('Invalid webhook signature', 401);
      }
    }

    const plan = this.webhookPlan(wf, ir);
    return {
      runIds: [await this.admitWebhookRun(wf, resolved, plan, coerceWebhookBody(inbound.body), newId())],
    };
  }

  /**
   * The SYNCHRONOUS chat intake: resolves the env pointer → PINNED
   * version → its `orchestr:chat` node, AWAITS the run, and returns the terminal-node
   * output as the reply. Auth is `none` — the unguessable URL is the capability.
   */
  async fireWorkflowChat(
    workflowId: string,
    environmentName: string,
    inbound: InboundChat,
  ): Promise<ChatReply> {
    const em = this.dataSource.manager;
    if (!isIdShape(workflowId)) throw new DomainError('Chat workflow not found', 404);
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    if (!wf) throw new DomainError('Chat workflow not found', 404);
    const resolved = await this.resolveEnvVersion(em, wf, environmentName);
    if (!resolved) throw new DomainError('Chat workflow not found', 404);
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: resolved.versionId } });
    const ir = version?.workflowIr as unknown as WorkflowIR | undefined;
    const chatNode = ir ? this.findChatNode(ir) : null;
    if (!ir || !chatNode) throw new DomainError('Chat workflow not found', 404);

    const sessionId =
      typeof inbound.sessionId === 'string' && inbound.sessionId.trim() ? inbound.sessionId : newId();
    // The SCOPED live-stream channel — must be built via the shared
    // `channelKey()` from the raw `(workflowId, environmentName)` so publish and subscribe agree.
    const chatChannelKey = channelKey(workflowId, environmentName, sessionId);
    const runId = newId();
    const initialScope = {
      trigger: { chatInput: inbound.chatInput, sessionId, action: inbound.action ?? null },
    };

    let plan;
    try {
      plan = this.compiler.compile(ir, wf.id);
    } catch (err) {
      throw new DomainError(`Chat workflow can't run: ${errorMessage(err)}`, 422);
    }

    // The `finally` close is the single authoritative stream-end signal for the scoped
    // SSE channel — it must fire on every exit (success, error, and timeout alike).
    try {
      const result = await runWithTimeout(
        this.runs.runExecutable(plan, {
          externalUserId: wf.userId ?? '',
          runId,
          initialScope,
          workflowId: wf.id,
          workflowVersionId: resolved.versionId,
          source: 'trigger',
          chatChannelKey,
          ...(resolved.environmentId
            ? { environment: resolved.environment, environmentId: resolved.environmentId, orgId: wf.orgId }
            : {}),
        }),
        CHAT_RUN_TIMEOUT_MS,
        runId,
      );

      return { runId, sessionId, reply: extractChatReply(ir, result), outputs: result.outputs };
    } finally {
      this.agentStepBus.close(chatChannelKey);
    }
  }

  /**
   * Fire an SDK REGISTERED-webhook delivery: hand the raw request to the SDK's
   * `handleRequest` (verify + transform + dedupe), then fire each surviving event as its own run.
   */
  private async fireRegisteredWebhookDelivery(
    wf: WorkflowEntity,
    resolved: { versionId: string; environmentId: string | null; environment: string },
    ir: WorkflowIR,
    node: IRNode,
    inbound: InboundWebhook,
  ): Promise<{ runIds: string[] }> {
    // The signing secret lives on the env-scoped activation row: no row / paused means we
    // cannot verify, so fail closed (inert 404) rather than fire an unverified body.
    if (!resolved.environmentId) throw new DomainError('Webhook not found', 404);
    const row = await this.dataSource.manager.findOne(RuntimeTriggerActivationEntity, {
      where: { workflowId: wf.id, environmentId: resolved.environmentId, triggerNodeId: node.id },
    });
    if (!row || row.paused) throw new DomainError('Webhook not found', 404);
    if (!holdsTrigger(row, triggerOf(ir, row.triggerNodeId))) {
      this.logger.warn(
        `webhook intake: activation ${row.id} is still to be changed at its app — acked, not fired`,
      );
      return { runIds: [] };
    }

    const store = new DbActivationStore(this.dataSource, row.id);
    // Read before the secret, so a delivery that secret verifies is named under the setup the secret belongs to.
    const epoch = await store.admissionEpoch();
    const [secret, registration] = await Promise.all([
      store.get<string>(WEBHOOK_SECRET_KEY),
      store.get<unknown>(WEBHOOK_REGISTRATION_KEY).then(webhookRegistrationOf),
    ]);
    // The SDK's dedupe mark lands only once every event's run is admitted, so a delivery that fails is resent whole.
    const delivery = new HeldWritesStore(store);

    let events: unknown[];
    try {
      events = await this.sdkWebhooks.handleRequest({
        externalUserId: row.connectionOwnerUserId ?? wf.userId ?? '',
        type: node.node_type,
        props: triggerPropsOf(node),
        // A held trigger's account isn't active, so nothing is sent with it (#11).
        auth: row.connectionId && !row.held ? { connectionId: row.connectionId } : null,
        store: delivery,
        // Only read by enable/disable (registration), never by verify/transform.
        webhookUrl: '',
        secret: secret ?? '',
        registration: registration ?? undefined,
        request: { headers: inbound.headers, body: inbound.body, rawBody: inbound.rawBody.toString('utf8') },
      });
    } catch (err) {
      throw mapRegisteredWebhookError(err);
    }

    // A delivery can legitimately yield zero events (deduped / handshake / unmatched) or
    // several. Report what actually ran — a minted id for a run nobody dispatched is a lie
    // the caller cannot tell from a real one.
    const runIds: string[] = [];
    if (events.length > 0) {
      const plan = this.webhookPlan(wf, ir);
      for (const payload of events) {
        // An event its trigger keys is run under an id of its own, so a resend admits it once.
        const key = this.sdkWebhooks.eventKey(node.node_type, payload);
        const runId = key === null ? newId() : nameBasedId(row.id, epoch, key);
        runIds.push(await this.admitWebhookRun(wf, resolved, plan, coerceWebhookBody(payload), runId));
      }
    }
    await delivery.commit();
    return { runIds };
  }

  /**
   * The GENERIC Composio trigger intake — one endpoint for every projected
   * trigger type: verify the signature, map `metadata.trigger_id` → the live activation(s)
   * subscribed to that instance, and fire each one (Composio shares a `ti_…` across holders).
   */
  async fireComposioDelivery(inbound: InboundWebhook): Promise<{ fired: number; duplicate?: boolean }> {
    const triggerId = composioDeliveryTriggerId(inbound.body);
    if (!triggerId) throw new DomainError('Composio delivery is missing metadata.trigger_id', 400);

    // Who this delivery is FOR has to be decided before it can be verified, because the secret
    // is per scope now. Reading the (still unverified) trigger id only NARROWS which secrets are
    // tried — a forged id cannot produce a valid signature, so this weakens nothing.
    const rows = await this.dataSource.manager.find(RuntimeTriggerActivationEntity, {
      where: { composioTriggerInstanceId: triggerId, paused: false },
    });
    if (rows.length === 0) {
      // A subscription with no live holder (stale delivery / pre-persist race) — ack, don't fire.
      // This also subsumes the old edition gate: nothing subscribed can never fire.
      this.logger.warn(`composio intake: no live activation for trigger instance ${triggerId}`);
      return { fired: 0 };
    }

    // Composio shares a `ti_…` across holders, so candidates can span scopes. Each scope is
    // verified against ITS OWN secret and only the ones that verify may fire — an unmatched or
    // secret-less scope is dropped, never processed on the assumption it is probably fine.
    const verifiedRows = await this.verifiedComposioHolders(inbound, rows);
    if (verifiedRows.length === 0) {
      this.logger.warn(`composio intake: rejected a delivery for ${triggerId} — unverified`);
      throw new DomainError('Invalid webhook signature', 401);
    }

    // Inbound idempotency: delivery is at-least-once, so claim the id before firing.
    // Deliberately AFTER verification — an unverified delivery must not burn a genuine one's id.
    const webhookId = inbound.headers['webhook-id'];
    if (!(await this.claimComposioDelivery(webhookId, triggerId))) {
      return { fired: 0, duplicate: true };
    }

    const payload = composioDeliveryPayload(inbound.body);
    const deliveryAccountId = composioDeliveryAccountId(inbound.body);
    let fired = 0;
    for (const row of verifiedRows) {
      fired += await this.fireComposioActivation(row, payload, deliveryAccountId, webhookId ?? null);
    }
    if (webhookId) {
      await this.dataSource.manager.update(
        ComposioWebhookDeliveryEntity,
        { webhookId, admittedAt: IsNull() },
        { admittedAt: now() },
      );
    }
    return { fired };
  }

  /** The candidate activations whose OWN scope verifies this delivery; fails closed per scope. */
  private async verifiedComposioHolders(
    inbound: InboundWebhook,
    rows: RuntimeTriggerActivationEntity[],
  ): Promise<RuntimeTriggerActivationEntity[]> {
    const decided = new Map<string, boolean>();
    const verified: RuntimeTriggerActivationEntity[] = [];
    for (const row of rows) {
      const scope = await this.platformKeys.scopeForWorkflow(row.workflowId);
      if (!scope) continue;
      const key = scope.kind === 'user' ? `u:${scope.userId}` : `o:${scope.orgId}`;
      let ok = decided.get(key);
      if (ok === undefined) {
        const result = await this.composioTriggers.verifyWebhook(scope, inbound.rawBody, inbound.headers);
        ok = result.ok;
        decided.set(key, ok);
      }
      if (ok) verified.push(row);
    }
    return verified;
  }

  /** Claim a delivery id — the insert IS the lock; false once a claim of it has every run admitted. No id → fires anyway (fail open). */
  private async claimComposioDelivery(webhookId: string | undefined, triggerId: string): Promise<boolean> {
    if (!webhookId) {
      this.logger.warn('composio intake: delivery has no webhook-id — cannot dedupe, firing anyway');
      return true;
    }
    const result = await this.dataSource.manager
      .createQueryBuilder()
      .insert()
      .into(ComposioWebhookDeliveryEntity)
      // Unadmitted until its runs are: the column's default is for a claim an earlier release makes, which fires as it claims.
      .values({ webhookId, triggerId, receivedAt: now(), admittedAt: null })
      .orIgnore() // ON CONFLICT DO NOTHING — the loser of the race gets 0 rows.
      // RETURNING is required — without it `raw` is always [] and everything reads as a duplicate.
      .returning('webhook_id')
      .execute();
    if ((result.raw as unknown[] | undefined)?.length === 1) {
      await this.pruneComposioDeliveries();
      return true;
    }
    const claim = await this.dataSource.manager.findOne(ComposioWebhookDeliveryEntity, {
      where: { webhookId },
    });
    if (claim?.admittedAt) {
      this.logger.log(`composio intake: duplicate delivery ${webhookId} (${triggerId}) — acked, not fired`);
      return false;
    }
    // Its claim's runs are not all admitted yet: each is admitted again under its own id, so none runs twice.
    this.logger.log(
      `composio intake: delivery ${webhookId} (${triggerId}) is not admitted yet — admitting its runs`,
    );
    return true;
  }

  /** TTL-prune the ledger. Throttled, best-effort — housekeeping must never fail an intake. */
  private async pruneComposioDeliveries(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastComposioDeliveryPruneAt < COMPOSIO_DELIVERY_PRUNE_INTERVAL_MS) return;
    this.lastComposioDeliveryPruneAt = nowMs;
    try {
      await this.dataSource.manager
        .createQueryBuilder()
        .delete()
        .from(ComposioWebhookDeliveryEntity)
        .where(`received_at < now() - interval '${COMPOSIO_DELIVERY_TTL_DAYS} days'`)
        .execute();
    } catch (err) {
      this.logger.warn(`composio delivery-ledger prune failed (non-fatal): ${errorMessage(err)}`);
    }
  }

  /**
   * Fire ONE activation for a verified Composio delivery, returning 1 once its run is admitted; one whose run or version could
   * not be read or admitted throws. A fire that fails otherwise is logged, and lands on `last_error` unless the row is held back, whose reason stands.
   */
  private async fireComposioActivation(
    row: RuntimeTriggerActivationEntity,
    payload: unknown,
    deliveryAccountId: string | null,
    webhookId: string | null,
  ): Promise<number> {
    // Defense in depth: never fire another connected account's event as this owner.
    if (deliveryAccountId && !(await this.activationAccountMatches(row, deliveryAccountId))) {
      this.logger.warn(
        `composio intake: activation ${row.id} connected-account mismatch (delivery ${deliveryAccountId}) — skipped`,
      );
      return 0;
    }
    const fired = await this.startComposioRun(row, payload, webhookId);
    if (fired === null) return 0;
    const outcome = fired === true ? null : activationError(fired.error);
    const em = this.dataSource.manager;
    try {
      // Written only over the row as read (its xmin), read again whenever another write lands first, so a hold's reason stands.
      let recorded = 0;
      while (recorded === 0) {
        const [read] = await rawQuery<{ version: string }>(
          em,
          `SELECT xmin::text AS version FROM runtime_trigger_activations WHERE id = $1`,
          [row.id],
        );
        const current = read && (await em.findOne(RuntimeTriggerActivationEntity, { where: { id: row.id } }));
        if (!current) break;
        recorded = await rawMutate(
          em,
          `UPDATE runtime_trigger_activations SET last_polled_at = $3, last_error = $4 WHERE id = $1 AND xmin = $2::xid`,
          [row.id, read.version, now(), heldBack(current) ? current.lastError : outcome],
        );
      }
    } catch (err) {
      this.logger.warn(
        `composio intake: activation ${row.id}: its fire was not recorded: ${errorMessage(err)}`,
      );
    }
    return fired === true ? 1 : 0;
  }

  // Admits a run of the version the activation's environment points at: true, why it can't run, or null when that version doesn't hold the trigger.
  private async startComposioRun(
    row: RuntimeTriggerActivationEntity,
    payload: unknown,
    webhookId: string | null,
  ): Promise<true | { error: unknown } | null> {
    const target = await this.pointedTarget(row);
    if ('missing' in target) return this.notFired(row, new Error(target.missing));
    if (!holdsTrigger(row, triggerOf(target.ir, row.triggerNodeId))) {
      this.logger.warn(
        `composio intake: activation ${row.id} is still to be changed at Composio — acked, not fired`,
      );
      return null;
    }
    let plan: DagPlan;
    try {
      plan = this.compiler.compile(target.ir, target.wf.id);
    } catch (error) {
      return this.notFired(row, error);
    }
    // One run per activation per delivery, so a resend admits each exactly once.
    const runId = webhookId ? nameBasedId(row.id, webhookId) : newId();
    await this.admitActivationRun(row, target, plan, runId, payload);
    return true;
  }

  private notFired(row: RuntimeTriggerActivationEntity, error: unknown): { error: unknown } {
    this.logger.warn(`composio intake: activation ${row.id} did not fire: ${errorMessage(error)}`);
    return { error };
  }

  /**
   * Does the delivery's Composio connected account match the one this activation subscribed
   * under? Returns `true` when the account can't be resolved — that can't PROVE a mismatch.
   */
  private async activationAccountMatches(
    row: RuntimeTriggerActivationEntity,
    deliveryAccountId: string,
  ): Promise<boolean> {
    if (!row.connectionId || !row.connectionOwnerUserId) return true; // no account to check
    const ref = await this.connections.managedRef(row.connectionOwnerUserId, row.connectionId);
    const account = ref?.connectedAccountId ?? null;
    return account === null || account === deliveryAccountId;
  }

  /** One poll cycle over the enabled schedule/polling activations, firing the due ones; once `signal` aborts it admits nothing more and waits on no run. Never throws. */
  async runActivationPollCycle(signal?: AbortSignal): Promise<void> {
    try {
      const rows = await this.dataSource.manager.find(RuntimeTriggerActivationEntity, {
        where: { paused: false },
      });
      let events = 0;
      for (const row of rows) {
        if (signal?.aborted) break;
        if (row.kind !== ORCHESTR_SCHEDULE_KIND && row.kind !== POLLING_KIND) continue;
        events += await this.pollActivation(row, signal);
      }
      if (rows.length > 0) {
        this.logger.log(`activation poll: ${rows.length} activation(s), ${events} event(s)`);
      }
    } catch (err) {
      this.logger.error(`activation poll cycle failed: ${errorMessage(err)}`);
    }
    // Orphan reaper — throttled to the sweep cadence, never throws.
    if (!signal?.aborted && Date.now() - this.lastComposioReapAt >= COMPOSIO_REAP_INTERVAL_MS) {
      this.lastComposioReapAt = Date.now();
      await this.reapOrphanedComposioSubscriptions().catch((err) =>
        this.logger.warn(`composio orphan reaper failed: ${errorMessage(err)}`),
      );
    }
  }

  /**
   * Delete every live Composio trigger instance on an account this install connected that no live activation
   * references — one Composio project can also serve another install, or the person's own code.
   * TWO-STRIKE grace is required: only reap an instance seen orphaned on the previous pass
   * too, so an in-flight subscribe (instance created, row not yet committed) is never killed.
   */
  async reapOrphanedComposioSubscriptions(): Promise<void> {
    // Per SCOPE: each Composio project is addressed by its own key, and we never try to delete
    // an instance we do not hold the key for.
    this.nextComposioOrphanCandidates = new Set();
    for (const scope of await this.composioScopes()) {
      await this.reapScope(scope);
    }
    this.composioOrphanCandidates = this.nextComposioOrphanCandidates;
  }

  /** Every scope that owns a live Composio subscription — the reaper's unit of work. */
  private async composioScopes(): Promise<PlatformKeyScope[]> {
    const rows: Array<{ user_id: string | null; org_id: string | null }> = await this.dataSource.query(
      `SELECT DISTINCT w.user_id, w.org_id
         FROM runtime_trigger_activations a
         JOIN workflows w ON w.id = a.workflow_id
        WHERE a.composio_trigger_instance_id IS NOT NULL AND a.paused = false`,
    );
    const scopes: PlatformKeyScope[] = [];
    for (const row of rows) {
      if (row.org_id) scopes.push({ kind: 'org', orgId: row.org_id });
      else if (row.user_id) scopes.push({ kind: 'user', userId: row.user_id });
    }
    return scopes;
  }

  private async reapScope(scope: PlatformKeyScope): Promise<void> {
    const live = await this.composioTriggers.listActiveInstances(scope);
    if (live.length === 0) return;
    const held = await this.connections.heldComposioAccounts();
    const ours = live
      .filter((instance) => instance.connectedAccountId !== null && held.has(instance.connectedAccountId))
      .map((instance) => instance.id);
    if (ours.length === 0) return;
    const rows = await this.dataSource.manager.find(RuntimeTriggerActivationEntity, {
      where: { composioTriggerInstanceId: In(ours), paused: false },
    });
    const referenced = new Set<string>();
    for (const row of rows) if (row.composioTriggerInstanceId) referenced.add(row.composioTriggerInstanceId);
    const orphans = ours.filter((id) => !referenced.has(id));
    const priorCandidates = this.composioOrphanCandidates;
    for (const id of orphans) this.nextComposioOrphanCandidates.add(id);
    const toReap = orphans.filter((id) => priorCandidates.has(id));
    if (toReap.length === 0) return;
    let reaped = 0;
    await runBounded(toReap, COMPOSIO_REAP_CONCURRENCY, async (id) => {
      try {
        await this.composioTriggers.deleteTriggerInstance(scope, id);
        reaped += 1;
      } catch (err) {
        this.logger.warn(`composio orphan reaper: delete ${id} failed: ${errorMessage(err)}`);
      }
    });
    if (reaped > 0) this.logger.log(`composio orphan reaper: deleted ${reaped} orphaned trigger instance(s)`);
  }

  /** Fire one due activation (schedule/polling). Compile/resolve failures land on its `last_error`. */
  private async pollActivation(
    loaded: RuntimeTriggerActivationEntity,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    // A reconcile holding the lock is changing this activation; the next cycle polls what it leaves.
    const polled = await ifActivationUnlocked(this.pool, loaded.id, async () => {
      const row = await this.dataSource.manager.findOne(RuntimeTriggerActivationEntity, {
        where: { id: loaded.id },
      });
      // Removed or changed since the cycle loaded it, or not stood up as it reads: its store is not this row's.
      if (!row || !sameLiveTrigger(row, loaded) || !applyFinished(actualOf(row))) return null;
      // Held back by its slot: nothing is stood up or polled, and `last_error` keeps the slot rule's refusal.
      if (heldBack(row)) return null;
      return this.pollLockedActivation(row, signal);
    }).catch((err: unknown) => {
      this.logger.warn(`activation ${loaded.id}: not polled this cycle: ${errorMessage(err)}`);
      return null;
    });
    if (!polled) return 0;
    // Only awaiting a run happens outside the lock (a run can wait for days); every write to the activation's store stays inside it.
    for (const run of polled) {
      if (signal?.aborted) break;
      await run.outcome(signal).catch((err: unknown) => {
        if (!(err instanceof ShuttingDown)) {
          this.logger.warn(`activation ${loaded.id}: fired run failed: ${String(err)}`);
        }
      });
    }
    return polled.length;
  }

  private async pollLockedActivation(
    row: RuntimeTriggerActivationEntity,
    signal: AbortSignal | undefined,
  ): Promise<AdmittedRun[] | null> {
    const em = this.dataSource.manager;
    try {
      const target = await this.resolveActivationTarget(row);
      // A pointer moved and its reconcile has yet to run: the live version does not hold this trigger.
      if (!holdsTrigger(row, triggerOf(target.ir, row.triggerNodeId))) return null;
      const plan = this.compiler.compile(target.ir, target.wf.id);
      const activationStore = new DbActivationStore(this.dataSource, row.id);
      // Minted straight to the store, so the poll after a failed one names its runs alike.
      const epoch = await activationStore.admissionEpoch();
      // The cursor moves only once every event's run is admitted, so a poll that fails part-way yields them again, each run admitted once.
      const store = new HeldWritesStore(activationStore);
      const events = await this.pollableEvents(row, store, target.wf);
      const admitted: AdmittedRun[] = [];
      for (const event of events) {
        if (signal?.aborted) throw new ShuttingDown();
        admitted.push(
          await this.admitActivationRun(
            row,
            target,
            plan,
            nameBasedId(row.id, epoch, event.key),
            event.payload,
          ),
        );
      }
      // The last write, so the epoch moves only with the cursor: a key the trigger later yields again names a new run.
      if (events.length > 0) await store.put(ADMISSION_EPOCH_KEY, newId());
      await store.commit();
      await em.update(
        RuntimeTriggerActivationEntity,
        { id: row.id },
        { lastPolledAt: now(), lastError: null },
      );
      return admitted;
    } catch (err) {
      // A stop leaves the activation as it was, its cursor unmoved, for the next boot to poll.
      if (err instanceof ShuttingDown) throw err;
      await em.update(
        RuntimeTriggerActivationEntity,
        { id: row.id },
        { lastPolledAt: now(), lastError: activationError(err) },
      );
      return null;
    }
  }

  // A run an activation's trigger fired, of the version its environment points at.
  private admitActivationRun(
    row: RuntimeTriggerActivationEntity,
    { wf, env, versionId }: ActivationTarget,
    plan: DagPlan,
    runId: string,
    payload: unknown,
  ): Promise<AdmittedRun> {
    return this.admitEvent(plan, {
      externalUserId: row.connectionOwnerUserId ?? wf.userId ?? '',
      runId,
      initialScope: { trigger: payload },
      workflowId: wf.id,
      workflowVersionId: versionId,
      source: 'trigger',
      environment: env.name,
      environmentId: env.id,
      orgId: wf.orgId,
    });
  }

  // An event whose id already holds a run it cannot start again was admitted before, so it is acknowledged, not refused.
  private async admitEvent(
    plan: DagPlan,
    opts: RunDispatchOptions & { runId: string },
  ): Promise<AdmittedRun> {
    try {
      return await this.runs.admit(plan, opts);
    } catch (err) {
      if (!isRunExists(err)) throw err;
      return { runId: opts.runId, outcome: () => Promise.reject(err) };
    }
  }

  /**
   * The events a due activation yields this cycle, dispatched by source: schedule tick,
   * SDK polling trigger, else the hand-polled Composio-poll rail.
   */
  private async pollableEvents(
    row: RuntimeTriggerActivationEntity,
    store: ProviderStore,
    wf: WorkflowEntity,
  ): Promise<TriggerEvent[]> {
    if (row.kind === ORCHESTR_SCHEDULE_KIND) return this.scheduleActivationEvents(row, store);
    const externalUserId = row.connectionOwnerUserId ?? wf.userId ?? '';
    if (this.sdkPolling.isPollingTrigger(row.triggerType)) {
      return this.sdkPolling.pollOne(row.triggerType, {
        externalUserId,
        props: row.props ?? {},
        auth: row.connectionId ? { connectionId: row.connectionId } : null,
        store,
      });
    }
    return this.lifecycle.pollTrigger({
      externalUserId,
      triggerId: row.triggerType,
      props: row.props ?? {},
      auth: row.connectionId ? { connectionId: row.connectionId } : undefined,
      store,
    });
  }

  /** A schedule activation's due tick — over the activation store (the canvas schedule). */
  private async scheduleActivationEvents(
    row: RuntimeTriggerActivationEntity,
    store: ProviderStore,
  ): Promise<TriggerEvent[]> {
    const schedule = parseScheduleProps(row.props);
    const cursor = await store.get<string>(SCHEDULE_CURSOR_KEY);
    const lastFire = cursor ? new Date(cursor) : row.createdAt;
    const nowTs = new Date();
    const scheduledAt = dueAt(schedule, lastFire, nowTs);
    if (!scheduledAt) return [];
    await store.put(SCHEDULE_CURSOR_KEY, nowTs.toISOString());
    const tick = scheduledAt.toISOString();
    return [{ payload: { scheduled_at: tick, timezone: schedule.timezone }, key: tick }];
  }

  /**
   * Resolve an activation row to its live fire target: workflow → env → PINNED version → IR.
   * Re-resolved on every fire (so a promote takes effect next tick); throws land on `last_error`.
   */
  private async resolveActivationTarget(row: RuntimeTriggerActivationEntity): Promise<ActivationTarget> {
    const target = await this.pointedTarget(row);
    if ('missing' in target) throw new Error(target.missing);
    return target;
  }

  // The version an activation's environment points at, or why there is none.
  private async pointedTarget(
    row: RuntimeTriggerActivationEntity,
  ): Promise<ActivationTarget | { missing: string }> {
    const em = this.dataSource.manager;
    const wf = await em.findOne(WorkflowEntity, { where: { id: row.workflowId } });
    if (!wf) return { missing: `Bound workflow ${row.workflowId} no longer exists` };
    const env = await em.findOne(EnvironmentEntity, { where: { id: row.environmentId } });
    if (!env) return { missing: `Activation environment ${row.environmentId} no longer exists` };
    const versionId = await this.envPointers.resolveVersionIdForEnv(em, wf, env);
    if (!versionId) return { missing: `Workflow "${wf.name}" has no version promoted to ${env.name} yet` };
    const version = await em.findOne(WorkflowVersionEntity, { where: { id: versionId } });
    if (!version?.workflowIr) return { missing: `Workflow "${wf.name}"'s ${env.name} version has no IR` };
    return { wf, env, versionId, ir: version.workflowIr as unknown as WorkflowIR };
  }

  // A held webhook or subscription fires what reaches it only while the version its environment points at holds it as it is live, a webhook at the intake served for it.
  private async firingWhileHeld(rows: RuntimeTriggerActivationEntity[]): Promise<Set<string>> {
    const firing = new Set<string>();
    const env = this.config.get('env', { infer: true });
    for (const row of rows) {
      if (!row.held || !firesWhileHeld(actualOf(row).kind)) continue;
      const target = await this.pointedTarget(row);
      if (!('ir' in target)) continue;
      const trigger = triggerOf(target.ir, row.triggerNodeId);
      const webhookUrl = servedWebhookUrl(env, row.workflowId, target.env.name);
      if (holdsTrigger(row, trigger && { ...trigger, webhookUrl })) firing.add(row.id);
    }
    return firing;
  }

  /**
   * Resolve a `(workflow, env)` hit to its pinned version; null when unknown/unpromoted.
   * Env names canonicalize at this seam (`prod → production`, invariant #7).
   */
  private async resolveEnvVersion(
    em: EntityManager,
    wf: WorkflowEntity,
    environmentName: string,
  ): Promise<{ versionId: string; environmentId: string | null; environment: string } | null> {
    const canonical = canonicalEnvName(environmentName);
    if (wf.orgId) {
      // An org's env is its row: a name no env carries any more serves nothing, whatever a pointer still says.
      const env = await this.environments.findByNameForOrg(em, wf.orgId, canonical);
      const versionId = env ? await this.envPointers.resolveVersionIdForEnv(em, wf, env) : null;
      return env && versionId ? { versionId, environmentId: env.id, environment: env.name } : null;
    }
    // Org-less workflow: only the prod alias can be promoted without an env row.
    const versionId = await this.envPointers.resolveVersionId(em, wf, canonical);
    return versionId ? { versionId, environmentId: null, environment: canonical } : null;
  }

  /** The single inbound-webhook trigger node of a version (native or registered-webhook); null if none. */
  private findInboundWebhookNode(ir: WorkflowIR): IRNode | null {
    return (
      ir.nodes.find(
        (n) => n.node_type === INCOMING_WEBHOOK_PUBLIC || this.sdkWebhooks.isRegisteredWebhook(n.node_type),
      ) ?? null
    );
  }

  /** The single `orchestr:chat` trigger node of a version; null if none. */
  private findChatNode(ir: WorkflowIR): IRNode | null {
    return ir.nodes.find((n) => n.node_type === INCOMING_CHAT_PUBLIC) ?? null;
  }

  // The env-pinned version a webhook delivery runs; one that can't compile refuses the delivery, since no run of it could start.
  private webhookPlan(wf: WorkflowEntity, ir: WorkflowIR): DagPlan {
    try {
      return this.compiler.compile(ir, wf.id);
    } catch (err) {
      this.logger.warn(`workflow-env webhook ${wf.id}: its pinned version can't run: ${errorMessage(err)}`);
      throw new DomainError(`Workflow can't run: ${errorMessage(err)}`, 422);
    }
  }

  // Admits a webhook delivery's run of an env-pinned version, env slots threaded when scoped; its outcome lands on the run.
  private async admitWebhookRun(
    wf: WorkflowEntity,
    resolved: { versionId: string; environmentId: string | null; environment: string },
    plan: DagPlan,
    eventPayload: unknown,
    runId: string,
  ): Promise<string> {
    await this.admitEvent(plan, {
      externalUserId: wf.userId ?? '',
      runId,
      initialScope: { trigger: eventPayload },
      workflowId: wf.id,
      workflowVersionId: resolved.versionId,
      source: 'webhook',
      ...(resolved.environmentId
        ? { environment: resolved.environment, environmentId: resolved.environmentId, orgId: wf.orgId }
        : {}),
    });
    return runId;
  }

  /**
   * The runtime health of a workflow's canvas-trigger activations — the read
   * counterpart of {@link pollActivation}'s writes. Authorized through the single policy point.
   */
  async activationHealth(principal: Principal, workflowId: string): Promise<ActivationHealth[]> {
    await this.access.require(principal, workflowId, 'read');
    const em = this.dataSource.manager;

    const rows = await em.find(RuntimeTriggerActivationEntity, {
      where: { workflowId },
      order: { createdAt: 'ASC' },
    });
    if (rows.length === 0) return [];

    // The env FK is always live (cascade delete), so the PROD_ENV fallback is defensive only.
    const envIds = [...new Set(rows.map((r) => r.environmentId))];
    const envs = await em.find(EnvironmentEntity, { where: { id: In(envIds) } });
    const nameById = new Map(envs.map((e) => [e.id, e.name]));
    const firing = await this.firingWhileHeld(rows);

    return rows.map((row) => ({
      environment: nameById.get(row.environmentId) ?? PROD_ENV,
      environment_id: row.environmentId,
      trigger_type: row.triggerType,
      kind: row.kind,
      active: !row.paused,
      held_back_by_slot: heldBack(row),
      listening: !row.paused && applyFinished(actualOf(row)) && (!heldBack(row) || firing.has(row.id)),
      status: activationStatus(row),
      last_polled_at: row.lastPolledAt?.toISOString() ?? null,
      last_error: row.lastError,
      updated_at: row.updatedAt?.toISOString() ?? null,
    }));
  }
}

/** Map an SDK `handleRequest` throw to the intake's status: 401 for a bad signature, else 400. */
function mapRegisteredWebhookError(err: unknown): DomainError {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return new DomainError('Invalid webhook signature', 401);
  const message = err instanceof Error && err.message ? err.message : 'Invalid webhook payload';
  return new DomainError(message, 400);
}

/**
 * Coerce a webhook delivery to the run's `trigger` scope. STABLE CONTRACT: `{{trigger.body}}`
 * is ALWAYS the whole raw payload whatever its shape; object keys are also spread, and `body`
 * deliberately wins over a same-named payload key (which stays at `{{trigger.body.body}}`).
 */
export function coerceWebhookBody(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), body }
    : { body };
}

function runWithTimeout<T>(work: Promise<T>, ms: number, runId: string): Promise<T> {
  return withDeadline(
    work,
    ms,
    () =>
      new DomainError(
        `Chat run ${runId} did not complete within ${ms}ms — chat is for fast flows; poll run history for the result`,
        504,
      ),
  );
}

function heldBack(row: RuntimeTriggerActivationEntity): boolean {
  return heldBackBySlot({ ...actualOf(row), held: row.held });
}

function sameLiveTrigger(a: RuntimeTriggerActivationEntity, b: RuntimeTriggerActivationEntity): boolean {
  return (
    a.triggerType === b.triggerType &&
    deepEqual(a.props, b.props) &&
    deepEqual(a.materialized, b.materialized)
  );
}

/** Roll an activation row up to a single health status (paused → error → ok → idle). */
function activationStatus(row: RuntimeTriggerActivationEntity): ActivationHealth['status'] {
  if (row.paused) return 'paused';
  if (row.lastError) return 'error';
  if (row.lastPolledAt) return 'ok';
  return 'idle';
}

/** The Composio trigger-instance id (`ti_…`) a delivery names; `null` → not routable (400). */
function composioDeliveryTriggerId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const metadata = isRecord(body.metadata) ? body.metadata : null;
  const fromMeta = metadata && typeof metadata.trigger_id === 'string' ? metadata.trigger_id : null;
  if (fromMeta) return fromMeta;
  return typeof body.trigger_id === 'string' && body.trigger_id ? body.trigger_id : null;
}

/** The Composio connected-account id a delivery names; `null` when absent (check skipped). */
function composioDeliveryAccountId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const metadata = isRecord(body.metadata) ? body.metadata : null;
  const id =
    metadata && typeof metadata.connected_account_id === 'string' ? metadata.connected_account_id : '';
  return id || null;
}

/** The payload downstream nodes see as `{{trigger}}` — the delivery's `data`, else the whole body. */
function composioDeliveryPayload(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return body.data;
  return body;
}
