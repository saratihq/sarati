import {
  type AuthHandle,
  type AuthScheme,
  createAuth,
  createDirectAuth,
  type DirectCredential,
  type FetchLike,
} from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import type { ConnectionsService } from '../connections/connections.service';
import {
  connectionIdOf,
  type CredentialGap,
  type LostAccount,
  lostAccountMessage,
  type RunAsStep,
  type RunAsWhere,
} from '../connections/run-as-account';
import { ComposioProxyTransport } from './composio-proxy-transport';

/**
 * The ONE credential-resolution path shared by every in-process SDK rail (actions AND the agent model call) —
 * a second copy would drift from the opaque-auth seam.
 */
export interface SdkAuthContext {
  /** The tenant the connection belongs to. */
  externalUserId: string;
  /** The step's connection reference (`{ connectionId }`) or an inline credential. */
  auth: unknown;
  /** The connection store; absent only in `new`-without-DI unit tests. */
  connections?: ConnectionsService;
  composioApiKey: string;
  composioBaseUrl: string;
  /** Test-only fetch in place of the network hop: the SDK's SSRF-guarded one for a direct credential, `composioFetch`'s for a managed one. */
  fetchImpl?: FetchLike;
  /** The step the run-as rule decided this account for, and where it runs; absent where no step runs, e.g. an options picker. */
  decided?: { step: Pick<RunAsStep, 'name' | 'app' | 'label'>; where: RunAsWhere };
}

const LOST = {
  removed: "The account chosen here no longer exists or isn't yours — pick another one on the step",
  inactive: "The account this step runs as isn't active — pick another one",
};

// An account that failed after the decision is worded as the decision would, where the run is.
async function lostAccount(ctx: SdkAuthContext, lost: LostAccount): Promise<DomainError> {
  const message =
    ctx.decided && ctx.connections
      ? await lostAccountMessage(lost, ctx.decided.step, ctx.decided.where, ctx.connections)
      : typeof lost === 'object'
        ? `This account ${lost.lacks} — ${lost.fix}, or pick another one`
        : LOST[lost];
  return new DomainError(message, lost === 'removed' ? 404 : 422);
}

/** The AuthHandle an SDK primitive runs on; a missing or ill-fitting account fails as the run-as decision words it, else with `needsConnectionMessage`. */
export async function resolveSdkAuthHandle(
  scheme: AuthScheme,
  ctx: SdkAuthContext,
  needsConnectionMessage: string,
): Promise<AuthHandle> {
  const fetchOptions: { fetchImpl?: FetchLike } = ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {};

  if (scheme.type === 'none') {
    return createDirectAuth(scheme, { type: 'none' }, fetchOptions);
  }

  const connectionId = connectionIdOf(ctx.auth);
  if (connectionId) {
    if (!ctx.connections) {
      throw new Error('Step references a connection, but the connections store is unavailable');
    }
    const ref = await ctx.connections.managedRef(ctx.externalUserId, connectionId);
    if (!ref) throw await lostAccount(ctx, 'removed');

    if (ref.authType === 'managed') {
      // A not-yet-runnable managed connection is a step precondition (422), not a 500.
      if (ref.status !== 'active') throw await lostAccount(ctx, 'inactive');
      if (!ref.connectedAccountId) {
        throw new DomainError(
          'The account this step runs as lost its link to the app — pick another one',
          422,
        );
      }
      if (!ctx.composioApiKey) {
        throw new DomainError(
          'This step runs on a managed connection, but managed connections are not configured',
          422,
        );
      }
      return createAuth(
        scheme,
        new ComposioProxyTransport({
          apiKey: ctx.composioApiKey,
          connectedAccountId: ref.connectedAccountId,
          baseUrl: ctx.composioBaseUrl,
          ...fetchOptions,
        }),
      );
    }

    // BYO/direct connection: decrypt and shape into an SDK DirectCredential.
    const credential = await ctx.connections.getCredential(ctx.externalUserId, connectionId);
    const direct = toDirectCredential(scheme, credential);
    if (!direct) throw await lostAccount(ctx, credential === null ? 'removed' : credentialGap(scheme));
    return createDirectAuth(scheme, direct, fetchOptions);
  }

  // No connection referenced: accept an inline credential, else a structured 422 naming what to attach.
  const inline = toDirectCredential(scheme, ctx.auth);
  if (!inline) throw new DomainError(needsConnectionMessage, 422);
  return createDirectAuth(scheme, inline, fetchOptions);
}

/** Shape a credential into a {@link DirectCredential} for the declared scheme, or `null` → the caller's 422. */
export function toDirectCredential(scheme: AuthScheme, credential: unknown): DirectCredential | null {
  if (scheme.type === 'basic') {
    const c = asRecord(credential);
    const username = typeof c?.username === 'string' ? c.username : '';
    const password = typeof c?.password === 'string' ? c.password : '';
    if (!username && !password) return null;
    return { type: 'basic', username, password };
  }
  const token = extractToken(credential);
  if (!token) return null;
  return scheme.type === 'apiKey' ? { type: 'apiKey', value: token } : { type: 'bearer', token };
}

/** What a connected credential lacks to sign in on this scheme, and what to reconnect it with. */
export function credentialGap(scheme: AuthScheme): CredentialGap {
  return scheme.type === 'basic'
    ? {
        lacks: 'has no username and password',
        fix: 'reconnect it with an email or username plus an API token or password',
      }
    : { lacks: 'has no API key or token', fix: 'reconnect it with one' };
}

/** {@link credentialGap} as one clause. */
export function unusableCredential(scheme: AuthScheme): string {
  const gap = credentialGap(scheme);
  return `${gap.lacks} — ${gap.fix}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Pull a token out of a stored/inline credential across the common shapes. */
export function extractToken(credential: unknown): string | null {
  if (typeof credential === 'string') return credential || null;
  const c = asRecord(credential);
  if (c) {
    for (const key of ['access_token', 'token', 'api_key', 'apiKey', 'secret_text', 'value']) {
      const value = c[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return null;
}
