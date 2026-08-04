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
import { ComposioProxyTransport } from './composio-proxy-transport';

/**
 * The ONE credential-resolution path shared by every in-process SDK rail (actions AND the agent model call) —
 * a second copy would drift from the ADR 0042 opaque-auth seam.
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
  /** Test fetch override; unset in production (the SDK transport uses global fetch). */
  fetchImpl?: FetchLike;
}

/**
 * Build the opaque {@link AuthHandle} an SDK primitive runs on: `none` → credential-free, MANAGED → the Composio
 * proxy transport (we hold no token), BYO/inline → the decrypted credential on the direct rail. The caller's
 * `needsConnectionMessage` becomes the 422 when no credential satisfies the scheme; the key only ever reaches the transport.
 */
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
    if (!ref) throw new DomainError(`Connection ${connectionId} not found`, 404);

    if (ref.authType === 'managed') {
      // A not-yet-runnable managed connection is a step precondition (422), not a 500.
      if (ref.status !== 'active') {
        throw new DomainError(
          `Connection ${connectionId} is not active yet — complete the connect flow, then retry`,
          422,
        );
      }
      if (!ref.connectedAccountId) {
        throw new DomainError(`Connection ${connectionId} has no managed account reference`, 422);
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
    if (!direct) throw new DomainError(needsConnectionMessage, 422);
    return createDirectAuth(scheme, direct, fetchOptions);
  }

  // No connection referenced: accept an inline credential, else a structured 422 naming what to attach.
  const inline = toDirectCredential(scheme, ctx.auth);
  if (!inline) throw new DomainError(needsConnectionMessage, 422);
  return createDirectAuth(scheme, inline, fetchOptions);
}

/** Extract a checkpoint-safe `{ connectionId }` reference, or null. */
export function connectionIdOf(auth: unknown): string | null {
  if (auth !== null && typeof auth === 'object' && 'connectionId' in auth) {
    const id = (auth as Record<string, unknown>).connectionId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Pull a token out of a stored/inline credential across the common shapes. */
function extractToken(credential: unknown): string | null {
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
