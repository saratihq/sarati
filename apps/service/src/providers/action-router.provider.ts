import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DomainError } from '../common/domain-error';
import { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import { ConnectionsService, type ManagedConnectionRef } from '../connections/connections.service';
import { resolveEnvSlotConnection } from '../connections/env-slot-resolver';
import {
  isComposioDirectApp,
  mustUseComposioFallback,
  parseFallbackOverride,
} from '../connections/managed-app-rails';
import type { EnvConfig } from '../config/env.config';
import { composioTriggerSpec, POLL_CURSOR_KEY, type ComposioTriggerSpec } from './composio-trigger.registry';
import { connectionIdOf } from './sdk-auth';
import { composioToolFor, isRoutableActionType, validatedAppSlug } from './sdk-actions.registry';
import { SdkActionsProvider } from './sdk-actions.provider';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';
import type {
  ManagedIntegrationProvider,
  RunActionInput,
  RunActionResult,
  TriggerEvent,
  TriggerInput,
} from './managed-integration-provider';

/**
 * The run-time resolution-priority seam across the two execution rails (our clean-room SDK and Composio), picking one
 * per action in the order marked (a0)/(a)/(b)/(c)/(d) in {@link ActionRouterProvider.runAction}. The decision is a
 * static registry/allowlist, never a run-time guess, and only MANAGED connections may take a Composio rail.
 */
@Injectable()
export class ActionRouterProvider implements ManagedIntegrationProvider {
  readonly key = 'router';
  private readonly logger = new Logger(ActionRouterProvider.name);
  private readonly fallbackOverride: ReadonlySet<string>;

  constructor(
    private readonly orchestrActions: SdkActionsProvider,
    private readonly composio: ComposioExecutionProvider,
    private readonly connections: ConnectionsService,
    config: ConfigService<{ env: EnvConfig }, true>,
    private readonly platformKeys: PlatformKeysService,
  ) {
    this.fallbackOverride = parseFallbackOverride(config.get('env', { infer: true }).composioFallbackApps);
  }

  /** Whose key this run uses: `scopeFor` is the ONE rule, so a personal-org id resolves to the user. */
  private scopeOf(input: { externalUserId: string; orgId?: string | null }): Promise<PlatformKeyScope> {
    return this.platformKeys.scopeFor(input.externalUserId, input.orgId ?? null);
  }

  async runAction(input: RunActionInput): Promise<RunActionResult> {
    // Env-scoping runs BEFORE routing, so every rail resolves the right account transparently.
    input = await this.applyEnvConnection(input);
    const appSlug = validatedAppSlug(input.actionId);
    // (a0) COMPOSIO-DIRECT apps: a managed connection executes via Composio typed execution
    //      ahead of every other rail (Google rejects the SDK's proxy leg); BYO/none falls through.
    if (appSlug && isComposioDirectApp(appSlug)) {
      const ref = await this.managedRefOf(input.externalUserId, input.auth);
      if (ref?.authType === 'managed') return this.runViaComposio(appSlug, input, ref);
    }
    // (a) OUR action wins whenever one exists for this public type.
    if (this.orchestrActions.has(input.actionId)) {
      this.logger.log(`Routing ${input.actionId} through our own action`);
      return this.orchestrActions.runAction(input);
    }
    // (b) TRANSPORT-GAP allowlist — a managed connection must run via Composio.
    if (appSlug && mustUseComposioFallback(appSlug, this.fallbackOverride)) {
      return this.runViaComposio(appSlug, input);
    }
    // (c) UNIVERSAL FALLBACK, else (d) an honest error — both decided by `isRoutableActionType`,
    //     the same gate the version-write commit check keys on, so commit-reject ⟺ run-400.
    if (appSlug && isRoutableActionType(input.actionId)) {
      return this.runViaComposio(appSlug, input);
    }
    throw this.unknownAction(input.actionId);
  }

  /**
   * Rebind a step's connection through the env's SLOT for `(environmentId, app)` (ADR 0014), via the SHARED resolver.
   * A connection-less step and a Default run are untouched; a missing slot is a hard 428, NEVER a personal-pool fallback.
   */
  private async applyEnvConnection(input: RunActionInput): Promise<RunActionInput> {
    if (!connectionIdOf(input.auth)) return input; // step uses no connection (http/text/…)
    const appSlug = validatedAppSlug(input.actionId);
    if (!appSlug) return input;
    const slot = await resolveEnvSlotConnection(this.connections, input, appSlug);
    if (!slot) return input; // Default run — the personal pool, untouched
    // Rebind the identity too — the downstream getCredential/managedRef is user-scoped, so the step must run as the owner.
    return { ...input, auth: { connectionId: slot.connectionId }, externalUserId: slot.ownerUserId };
  }

  private async runViaComposio(
    appSlug: string,
    input: RunActionInput,
    resolvedRef?: ManagedConnectionRef,
  ): Promise<RunActionResult> {
    // Composio typed execution runs on their side and can't be partially simulated — a dry run returns a stub.
    if (input.dryRun) {
      return { output: { dry_run: true, skipped: 'composio typed execution (not simulated in a dry run)' } };
    }
    const connectionId = connectionIdOf(input.auth);
    if (!connectionId) {
      throw new DomainError(
        `"${appSlug}" runs on a managed connection — add one and reference it on this step`,
      );
    }
    const ref = resolvedRef ?? (await this.connections.managedRef(input.externalUserId, connectionId));
    if (!ref) throw new DomainError(`Connection ${connectionId} not found`, 404);
    if (ref.authType !== 'managed' || !ref.connectedAccountId) {
      // A BYO/direct connection can't take the fallback — Composio has no custody of its auth.
      throw new DomainError(
        `"${appSlug}" needs a managed connection to run — a bring-your-own connection can't execute this app`,
      );
    }
    if (ref.status !== 'active') {
      throw new DomainError(
        `Connection ${connectionId} (${appSlug}) is not active yet — complete the connect flow, then retry`,
      );
    }
    const scope = await this.scopeOf(input);
    if (!(await this.composio.isConfigured(scope))) {
      throw new DomainError(
        `"${appSlug}" runs through a managed connection, but no Composio API key is set for this workspace`,
      );
    }
    this.logger.log(
      `Routing ${appSlug}.${this.actionNameOf(input.actionId)} through the Composio fallback rail`,
    );
    // `input.idempotencyKey` is DELIBERATELY not forwarded (ADR 0040): Composio's typed execute API has no
    // idempotency parameter, so this rail is an accepted at-least-once exception and must never error for lacking a key.
    return this.composio.execute({
      scope,
      appSlug,
      actionName: this.actionNameOf(input.actionId),
      props: input.props,
      connectedAccountId: ref.connectedAccountId,
      userId: input.externalUserId,
      // The EXACT tool this action was built from, so execution routes by slug rather than re-deriving it from the name.
      tool: composioToolFor(input.actionId),
    });
  }

  // ─── Triggers: a MANAGED connection with a Composio-poll registry spec; anything else is unsupported. ───

  async enableTrigger(input: TriggerInput): Promise<void> {
    const route = await this.composioTriggerRoute(input);
    if (!route) throw this.unsupportedTrigger(input.triggerId);
    // Seed the cursor at "now" so only post-enable items fire.
    await input.store.put(POLL_CURSOR_KEY, Date.now());
  }

  async pollTrigger(input: TriggerInput): Promise<TriggerEvent[]> {
    const route = await this.composioTriggerRoute(input);
    if (!route) throw this.unsupportedTrigger(input.triggerId);
    return this.pollViaComposio(route.spec, input, route.ref);
  }

  async disableTrigger(_input: TriggerInput): Promise<void> {
    // Composio polling holds no subscription, so there is nothing to tear down.
    return Promise.resolve();
  }

  /** The Composio poll route, or null → unsupported: needs BOTH a registry spec and a MANAGED connection. */
  private async composioTriggerRoute(
    input: TriggerInput,
  ): Promise<{ spec: ComposioTriggerSpec; ref: ManagedConnectionRef } | null> {
    const spec = composioTriggerSpec(input.triggerId);
    if (!spec) return null;
    const ref = await this.managedRefOf(input.externalUserId, input.auth);
    return ref?.authType === 'managed' ? { spec, ref } : null;
  }

  /** Neither of the two rails can enable/poll this trigger. */
  private unsupportedTrigger(triggerId: string): DomainError {
    if (composioTriggerSpec(triggerId)) {
      return new DomainError(
        `The ${triggerId} trigger needs a managed connection to poll — connect one and retry`,
        428,
      );
    }
    return new DomainError(`Trigger "${triggerId}" is no longer supported`, 400);
  }

  /** One poll with TIMEBASED cursor semantics: advance to the newest seen epoch, emit only items STRICTLY newer than the last. */
  private async pollViaComposio(
    spec: ComposioTriggerSpec,
    input: TriggerInput,
    ref: ManagedConnectionRef,
  ): Promise<TriggerEvent[]> {
    const triggerType = input.triggerId;
    if (ref.status !== 'active' || !ref.connectedAccountId) {
      throw new DomainError(
        `The ${triggerType} trigger's connection is not active — complete the connect flow, then retry`,
      );
    }
    const scope = await this.scopeOf(input);
    if (!(await this.composio.isConfigured(scope))) {
      throw new DomainError(
        `${triggerType} polls through a managed connection, but no Composio API key is set for this workspace`,
      );
    }
    const lastPoll = (await input.store.get<number>(POLL_CURSOR_KEY)) ?? 0;
    const data = await this.composio.executeBySlug(scope, spec.toolSlug, {
      connectedAccountId: ref.connectedAccountId,
      userId: input.externalUserId,
      arguments: spec.buildArguments(input.props, lastPoll),
    });
    const items = spec.extractItems(data);
    const newest = items.reduce((max, item) => Math.max(max, item.epochMilliSeconds), lastPoll);
    await input.store.put(POLL_CURSOR_KEY, newest);
    return items
      .filter((item) => item.epochMilliSeconds > lastPoll)
      .map((item) => ({ payload: item.payload }));
  }

  /** The step/trigger connection's managed ref, or null (no/foreign connection). */
  private async managedRefOf(externalUserId: string, auth: unknown): Promise<ManagedConnectionRef | null> {
    const connectionId = connectionIdOf(auth);
    if (!connectionId) return null;
    return this.connections.managedRef(externalUserId, connectionId);
  }

  /** The action name of an action id (the part after `<slug>.`). */
  private actionNameOf(actionId: string): string {
    const dot = actionId.indexOf('.');
    return dot >= 0 ? actionId.slice(dot + 1) : actionId;
  }

  /** No SDK action and no Composio home for this action id — an honest 400. */
  private unknownAction(actionId: string): DomainError {
    const slug = validatedAppSlug(actionId);
    return new DomainError(
      slug
        ? `No installed rail can run "${actionId}" — "${slug}" has no SDK action and no managed (Composio) connection`
        : `Malformed action id "${actionId}" — expected "<app>.<action>"`,
      400,
    );
  }
}
