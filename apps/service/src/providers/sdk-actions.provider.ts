import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type AuthHandle, type AuthScheme, type DropdownResult, type FetchLike } from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { ConnectionsService } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import { sdkAction, isSdkActionType } from './sdk-actions.registry';
import { IdempotencyHttpClient } from './idempotency-http-client';
import { DryRunHttpClient } from './dry-run-http-client';
import { PlatformKeysService } from '../platform/platform-keys.service';
import { resolveSdkAuthHandle } from './sdk-auth';
import type { RunActionInput, RunActionResult } from './managed-integration-provider';

/** Optional fetch override for the SDK transports; unset in production (the SDK uses the global fetch). */
export const SDK_ACTIONS_FETCH = Symbol('SDK_ACTIONS_FETCH');

/**
 * Runs OUR clean-room SDK actions IN-PROCESS — the first rail in the router's resolution priority. Owns credential
 * resolution and the SDK glue; a run-but-fails outcome is a STRUCTURED 422, never an opaque 500. A delegate of
 * {@link ActionRouterProvider}, not a rail the runtime binds, so it has no trigger lifecycle.
 */
@Injectable()
export class SdkActionsProvider {
  private readonly logger = new Logger(SdkActionsProvider.name);
  private readonly composioBaseUrl: string;

  constructor(
    config: ConfigService<{ env: EnvConfig }, true>,
    // Optional so the provider stays `new`-able in unit tests without DI.
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() @Inject(SDK_ACTIONS_FETCH) private readonly fetchImpl?: FetchLike,
    @Optional() private readonly platformKeys?: PlatformKeysService,
  ) {
    this.composioBaseUrl = config.get('env', { infer: true }).composioBaseUrl;
  }

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
    const auth = await this.authFor(input, input.actionId, input.auth, action.auth);
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
      return { options: [], disabled: true, placeholder: 'Type a value' };
    }
  }

  /** The opaque {@link AuthHandle} the action runs on — the shared credential path, {@link resolveSdkAuthHandle}. */
  /** Whose Composio key this action runs on — the run's own scope, never a shared one. */
  private async composioKeyFor(input: {
    externalUserId: string;
    orgId?: string | null;
  }): Promise<string | undefined> {
    if (!this.platformKeys) return undefined;
    const scope = await this.platformKeys.scopeFor(input.externalUserId, input.orgId ?? null);
    return this.platformKeys.composioApiKey(scope);
  }

  private async authFor(
    owner: { externalUserId: string; orgId?: string | null },
    actionId: string,
    auth: unknown,
    scheme: AuthScheme,
  ): Promise<AuthHandle> {
    return resolveSdkAuthHandle(
      scheme,
      {
        externalUserId: owner.externalUserId,
        auth,
        ...(this.connections ? { connections: this.connections } : {}),
        composioApiKey: (await this.composioKeyFor(owner)) ?? '',
        composioBaseUrl: this.composioBaseUrl,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
      this.needsConnectionMessage(actionId),
    );
  }

  /** The "attach a connection" step-precondition text (422), naming the app slug. */
  private needsConnectionMessage(actionId: string): string {
    const slug = actionId.slice(0, actionId.indexOf('.')) || 'account';
    return `Step "${actionId}" requires a ${slug} connection — attach one to this step and retry`;
  }

  /** Map an SDK failure to a structured 422 step failure carrying the normalized, secret-free message. */
  private toStepError(actionId: string, err: unknown): DomainError {
    const message = errorMessage(err);
    this.logger.warn(`SDK action ${actionId} failed: ${message}`);
    return new DomainError(`${actionId} failed: ${message}`, 422);
  }
}

/** A step that stopped at a state-changing request: a real outcome, never a failure. */
function skippedResult(dryRun: DryRunHttpClient): RunActionResult {
  return {
    output: {
      dry_run: true,
      skipped: 'state-changing request (not sent in a dry run)',
      would_call: dryRun.skipped.map(({ method, url }) => ({ method, url })),
    },
  };
}
