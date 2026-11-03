import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  type AuthHandle,
  type AuthScheme,
  type DropdownResult,
  type FetchLike,
  type Transport,
} from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { ComposioProvider } from '../connections/composio.provider';
import { ConnectionsService } from '../connections/connections.service';
import { actionStep, noAccountMessage } from '../connections/run-as-account';
import { monthlyLimitOf } from '../platform/composio-usage.service';
import { sdkAction, isSdkActionType } from './sdk-actions.registry';
import { IdempotencyHttpClient } from './idempotency-http-client';
import { DryRunHttpClient } from './dry-run-http-client';
import { withheldWrite } from './dry-run-marker';
import { PlatformKeysService } from '../platform/platform-keys.service';
import { resolveSdkAuthHandle, type SdkAuthContext } from './sdk-auth';
import type { RunActionInput, RunActionResult } from './managed-integration-provider';

/** Test-only fetch in place of the network hop: the SDK's SSRF-guarded one for a direct credential, `composioFetch`'s for a managed one. */
export const SDK_ACTIONS_FETCH = Symbol('SDK_ACTIONS_FETCH');

/**
 * Runs OUR clean-room SDK actions IN-PROCESS — the first rail in the router's resolution priority. Owns credential
 * resolution and the SDK glue; a run-but-fails outcome is a STRUCTURED 422, never an opaque 500. A delegate of
 * {@link ActionRouterProvider}, not a rail the runtime binds, so it has no trigger lifecycle.
 */
@Injectable()
export class SdkActionsProvider {
  private readonly logger = new Logger(SdkActionsProvider.name);

  constructor(
    // Optional so the provider stays `new`-able in unit tests without DI.
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() @Inject(SDK_ACTIONS_FETCH) private readonly fetchImpl?: FetchLike,
    @Optional() private readonly platformKeys?: PlatformKeysService,
    @Optional() private readonly composio?: ComposioProvider,
  ) {}

  /** Whether `type` is one of OUR actions — the router's ours-first gate. */
  has(type: string): boolean {
    return isSdkActionType(type);
  }

  async runAction(input: RunActionInput): Promise<RunActionResult> {
    const action = sdkAction(input.actionId);
    if (!action) {
      // A miss is a wiring bug, not a user error, so it stays a 500 (unlike the run-but-fails 422 below).
      throw new Error(`SdkActionsProvider has no action for "${input.actionId}"`);
    }
    // Only a run names a step; an account check (the identity probe) runs none, so its failure names none.
    const decided = input.stepName ? { step: actionStep(input), where: input } : undefined;
    const auth = await this.authFor(input, input.actionId, input.auth, action.auth, decided);
    // A dry run refuses mutating requests; otherwise a deterministic Idempotency-Key stops a crash-replay double-firing.
    const dryRun = input.dryRun ? new DryRunHttpClient() : null;
    const http =
      dryRun ?? (input.idempotencyKey ? new IdempotencyHttpClient(input.idempotencyKey) : undefined);
    try {
      const output = await action.execute({ auth, props: input.props, ...(http ? { http } : {}) });
      // Anything the action returned about a refused write is fabricated — report the skip instead.
      return dryRun && dryRun.skipped.length > 0 ? skippedResult(dryRun) : { output };
    } catch (err) {
      if (dryRun && dryRun.skipped.length > 0) return skippedResult(dryRun);
      throw this.toStepError(input.actionId, err);
    }
  }

  /** The inspector's live dropdown picker; a loader that can't run degrades to a disabled result, never a 500. */
  async loadOptions(
    type: string,
    propName: string,
    ctx: { externalUserId: string; orgId?: string | null; connectionId?: string; search?: string },
  ): Promise<DropdownResult<unknown>> {
    const action = sdkAction(type);
    if (!action) throw new DomainError(`Unknown action "${type}"`, 404);
    let auth: AuthHandle | undefined;
    if (ctx.connectionId) {
      auth = await this.authFor(ctx, type, { connectionId: ctx.connectionId }, action.auth);
    }
    try {
      return await action.loadOptions(propName, {
        ...(auth ? { auth } : {}),
        ...(ctx.search ? { search: ctx.search } : {}),
      });
    } catch (err) {
      // A loader needing another prop's value (or a transient fetch failure) must not block the inspector.
      this.logger.warn(`Options loader ${type}.${propName} failed, degrading to text: ${String(err)}`);
      return { options: [], disabled: true, placeholder: placeholderAfter(err) };
    }
  }

  /** The managed transport this action's owner context opens: the key their scope reads, as the run's own scope always has. */
  private async managedTransport(
    owner: { externalUserId: string; orgId?: string | null },
    connectedAccountId: string,
    personId: string,
  ): Promise<Transport | null> {
    if (!this.platformKeys || !this.composio) return null;
    const scope = await this.platformKeys.scopeFor(owner.externalUserId, owner.orgId ?? null);
    return this.composio.proxyTransportFor(scope, connectedAccountId, personId, this.fetchImpl);
  }

  private async authFor(
    owner: { externalUserId: string; orgId?: string | null },
    actionId: string,
    auth: unknown,
    scheme: AuthScheme,
    decided?: SdkAuthContext['decided'],
  ): Promise<AuthHandle> {
    return resolveSdkAuthHandle(
      scheme,
      {
        externalUserId: owner.externalUserId,
        auth,
        ...(this.connections ? { connections: this.connections } : {}),
        managedTransport: (accountId, personId) => this.managedTransport(owner, accountId, personId),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        ...(decided ? { decided } : {}),
      },
      noAccountMessage(decided?.step ?? actionStep({ actionId })),
    );
  }

  /** Map an SDK failure to a structured 422 step failure carrying the normalized, secret-free message. */
  private toStepError(actionId: string, err: unknown): DomainError {
    const message = errorMessage(err);
    this.logger.warn(`SDK action ${actionId} failed: ${message}`);
    const limit = monthlyLimitOf(err);
    return new DomainError(`${actionId} failed: ${message}`, limit ? 429 : 422, limit?.details);
  }
}

function placeholderAfter(err: unknown): string {
  const limit = monthlyLimitOf(err);
  if (!limit) return 'Type a value';
  return limit.details.limit === 0
    ? 'App actions are off on this instance'
    : `App action limit reached — resets ${limit.resetsOn} (UTC)`;
}

/** A step that stopped at a state-changing request: a real outcome, never a failure. */
function skippedResult(dryRun: DryRunHttpClient): RunActionResult {
  return { output: withheldWrite(dryRun.skipped) };
}
