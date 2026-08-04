import {
  type AuthHandle,
  type AuthScheme,
  createDirectAuth,
  type DirectCredential,
  type DropdownResult,
  type FetchLike,
  HttpClient,
  type ManifestEntry,
  resolveOptions,
  type TriggerStore,
} from '@sarati/actions-sdk';

import { serializeAuthScheme } from './sdk-actions.registry';

import { DomainError } from '../common/domain-error';
import { ConnectionsService, MANAGED_TOKEN_PREFIX } from '../connections/connections.service';
import type { ProviderStore } from './provider-store';

/** Shared glue for the two IN-PROCESS SDK trigger rails — credential resolution, the store adapter, the catalog row. */

/** Pull a bearer token out of a stored/inline credential across the common shapes. */
export function extractToken(credential: unknown): string | null {
  if (typeof credential === 'string') return credential || null;
  if (credential && typeof credential === 'object') {
    const c = credential as Record<string, unknown>;
    for (const key of ['access_token', 'token', 'api_key', 'apiKey', 'secret_text', 'value']) {
      if (typeof c[key] === 'string' && c[key]) return c[key];
    }
  }
  return null;
}

/**
 * Resolve a trigger's credential into an SDK {@link DirectCredential} — a `none` scheme needs no token, a
 * `{connectionId}` is decrypted, an inline credential passes through. A MANAGED connection is rejected: its
 * sentinel is not a usable token and must never be sent to a provider as a bearer.
 */
export async function resolveTriggerCredential(
  connections: ConnectionsService | undefined,
  externalUserId: string,
  auth: Record<string, unknown> | null,
  scheme: AuthScheme,
): Promise<DirectCredential> {
  if (scheme.type === 'none') return { type: 'none' };
  let resolved: unknown = auth;
  if (auth && typeof auth.connectionId === 'string') {
    if (!connections) {
      throw new Error('Trigger references a connection, but the connections store is unavailable');
    }
    resolved = await connections.getCredential(externalUserId, auth.connectionId);
  }
  const token = extractToken(resolved);
  if (!token) {
    throw new Error('This trigger needs a connected account to run — connect the app first');
  }
  if (token.startsWith(MANAGED_TOKEN_PREFIX)) {
    throw new Error(
      'This trigger needs a directly-authenticated connection — a managed (Composio) connection cannot be used on the direct rail. Reconnect the app with your own credentials.',
    );
  }
  return { type: 'bearer', token };
}

/** Build the opaque auth handle a direct-rail trigger runs on (test-injectable fetch when set). */
export function buildDirectAuth(
  scheme: AuthScheme,
  credential: DirectCredential,
  fetchImpl?: FetchLike,
): AuthHandle {
  return fetchImpl
    ? createDirectAuth(scheme, credential, { fetchImpl })
    : createDirectAuth(scheme, credential);
}

/** Adapt the runtime {@link ProviderStore} (get/put/delete) to the SDK {@link TriggerStore} (get/set). */
export function sdkStore(store: ProviderStore): TriggerStore {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return (await store.get<T>(key)) ?? undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await store.put(key, value);
    },
  };
}

/**
 * Project an SDK trigger's manifest into a picker catalog row (the shared wire shape). Each param must carry the FULL
 * authoring surface — `label`, static `options`, `defaultValue` — or every trigger dropdown degrades to a bare text box.
 */
export function triggerCatalogEntry(
  manifest: ManifestEntry,
  sample?: unknown,
  scheme?: AuthScheme,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(manifest.props)) {
    parameters[name] = {
      type: prop.type,
      label: prop.displayName,
      description: prop.description ?? '',
      required: prop.required,
      ...(prop.defaultValue !== undefined ? { defaultValue: prop.defaultValue } : {}),
      ...(prop.options !== undefined ? { options: prop.options } : {}),
    };
  }
  return {
    name: manifest.displayName,
    type: manifest.type,
    category: manifest.type.split('.')[0] ?? 'webhook',
    description: manifest.description,
    parameters,
    auth: manifest.authType === 'none' ? 'none' : 'connection',
    // Without this every SDK trigger reads as Composio-managed, sending a caller to the wrong credential.
    ...(scheme ? { authScheme: serializeAuthScheme(scheme) } : {}),
    ...(sample !== undefined ? { sample } : {}),
  };
}

/** The dropdown-family prop schema shape `loadTriggerOptions` resolves (the SDK's own kinds). */
interface DropdownishSchema {
  kind: string;
  options: unknown;
}

/**
 * Resolve a trigger prop's LIVE dropdown options — the trigger twin of an action's `loadOptions`. Static options need
 * no auth; every unloadable state degrades to a DISABLED result with a what-to-do placeholder, never a 500.
 */
export async function loadTriggerOptions(
  trigger: { props: Record<string, unknown>; auth: AuthScheme },
  prop: string,
  opts: {
    connections: ConnectionsService | undefined;
    externalUserId: string;
    connectionId?: string;
    search?: string;
    fetchImpl?: FetchLike;
  },
): Promise<DropdownResult<unknown>> {
  const schema = trigger.props[prop] as DropdownishSchema | undefined;
  if (!schema || (schema.kind !== 'dropdown' && schema.kind !== 'multiSelect')) {
    throw new DomainError(`"${prop}" is not a dropdown on this trigger`, 400);
  }
  const dropdownSchema = schema as Parameters<typeof resolveOptions>[0];
  // Static options need no credential — resolve straight off the schema.
  if (Array.isArray(schema.options)) return resolveOptions(dropdownSchema, {});
  if (!opts.connectionId) {
    return { options: [], disabled: true, placeholder: 'Connect an account to load options' };
  }
  try {
    const credential = await resolveTriggerCredential(
      opts.connections,
      opts.externalUserId,
      { connectionId: opts.connectionId },
      trigger.auth,
    );
    const auth = buildDirectAuth(trigger.auth, credential, opts.fetchImpl);
    return await resolveOptions(dropdownSchema, {
      auth,
      http: new HttpClient(),
      ...(opts.search ? { search: opts.search } : {}),
    });
  } catch (err) {
    // A revoked token, a provider 5xx, a managed connection — authoring-time states, not server faults.
    return {
      options: [],
      disabled: true,
      placeholder: err instanceof Error ? err.message : 'Couldn’t load options for this account',
    };
  }
}
