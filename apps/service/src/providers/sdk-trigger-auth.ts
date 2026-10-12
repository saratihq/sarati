import {
  type AuthHandle,
  type AuthScheme,
  createAuth,
  createDirectAuth,
  type DirectCredential,
  DirectTransport,
  type DropdownResult,
  type FetchLike,
  HttpClient,
  type ManifestEntry,
  type NormalizedResponse,
  resolveOptions,
  type TriggerStore,
} from '@sarati/actions-sdk';

import { appSlugOf, serializeAuthScheme } from './sdk-actions.registry';

import { DomainError } from '../common/domain-error';
import { ConnectionsService, MANAGED_TOKEN_PREFIX } from '../connections/connections.service';
import type { ProviderStore } from './provider-store';
import { extractToken, toDirectCredential, unusableCredential } from './sdk-auth';

/** Shared glue for the two IN-PROCESS SDK trigger rails — credential resolution, the store adapter, the catalog row. */

const NEEDS_CONNECTION = 'This trigger needs a connected account to run — connect the app first';

/** The connection a trigger references no longer exists for its owner. */
export class ConnectionGoneError extends Error {
  constructor() {
    super(NEEDS_CONNECTION);
  }
}

/** A trigger's credential shaped for its scheme; a managed connection is refused. */
export async function resolveTriggerCredential(
  connections: ConnectionsService | undefined,
  externalUserId: string,
  auth: Record<string, unknown> | null,
  scheme: AuthScheme,
): Promise<DirectCredential> {
  if (scheme.type === 'none') return { type: 'none' };
  let resolved: unknown = auth;
  const connectionId = typeof auth?.connectionId === 'string' ? auth.connectionId : null;
  if (connectionId !== null) {
    if (!connections) {
      throw new Error('Trigger references a connection, but the connections store is unavailable');
    }
    resolved = await connections.getCredential(externalUserId, connectionId);
    if (resolved === null) throw new ConnectionGoneError();
  }
  if (extractToken(resolved)?.startsWith(MANAGED_TOKEN_PREFIX)) {
    throw new Error(
      'This trigger needs a directly-authenticated connection — a managed (Composio) connection cannot be used on the direct rail. Reconnect the app with your own credentials.',
    );
  }
  const credential = toDirectCredential(scheme, resolved);
  if (credential) return credential;
  throw new Error(
    connectionId === null ? NEEDS_CONNECTION : `This trigger's connection ${unusableCredential(scheme)}`,
  );
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

/** {@link buildDirectAuth}, reporting every response it receives to `onResponse`. */
export function buildObservedDirectAuth(
  scheme: AuthScheme,
  credential: DirectCredential,
  fetchImpl: FetchLike | undefined,
  onResponse: (response: NormalizedResponse) => void,
): AuthHandle {
  const direct = new DirectTransport({ scheme, credential, ...(fetchImpl ? { fetchImpl } : {}) });
  return createAuth(scheme, {
    kind: direct.kind,
    send: async (request) => {
      const response = await direct.send(request);
      onResponse(response);
      return response;
    },
  });
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
    ...(scheme ? { authScheme: serializeAuthScheme(scheme, appSlugOf(manifest.type)) } : {}),
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
