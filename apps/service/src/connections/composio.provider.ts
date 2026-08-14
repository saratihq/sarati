import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { request } from 'undici';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { isRecord } from '../common/json-util';
import type { EnvConfig } from '../config/env.config';
import { ComposioAuthConfigEntity } from '../database/entities/composio-auth-config.entity';
import { now } from '../database/ids';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';

/** Cache partition per owning scope — never share one scope's Composio project data with another. */
function scopeKey(scope: PlatformKeyScope): string {
  return scope.kind === 'user' ? `u:${scope.userId}` : `o:${scope.orgId}`;
}

const REQUEST_TIMEOUT_MS = 15_000;
const TOOLKIT_CACHE_TTL_MS = 10 * 60_000;
/** Connected-account metadata (auth.data.*) changes rarely — cache per account. */
const METADATA_CACHE_TTL_MS = 5 * 60_000;
/** Composio caps toolkit pages at 1000. */
const TOOLKIT_PAGE_LIMIT = 1000;
const TOOL_PAGE_LIMIT = 100;
/** Trigger-type catalog page size (ADR 0046). */
const TRIGGER_TYPE_PAGE_LIMIT = 100;
/** Active trigger-instance page size (ADR 0046 orphan reaper). */
const TRIGGER_INSTANCE_PAGE_LIMIT = 100;

/**
 * The `ti_…` id of a `GET /trigger_instances/active` item, read from whichever key exposes it.
 * The `ti_` prefix is REQUIRED so the reaper can never mistake a non-instance id for one and delete the wrong thing.
 */
function activeTriggerInstanceId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  for (const key of ['id', 'trigger_id', 'triggerId', 'nanoId', 'nano_id']) {
    const value = raw[key];
    if (typeof value === 'string' && value.startsWith('ti_')) return value;
  }
  return null;
}

/** `state.val` fields that ARE the (masked) secret — dropped from `auth.data` so they can't masquerade as a usable credential. */
const SECRET_METADATA_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'api_key',
  'password',
]);

function looksRedacted(value: unknown): boolean {
  return typeof value === 'string' && /^redacted/i.test(value);
}

/** The non-secret metadata surfaced as `auth.data.*` — everything in `state.val` except the masked secret fields. */
function extractAccountMetadata(body: unknown): Record<string, unknown> {
  const state = isRecord(body) ? body.state : null;
  const val = isRecord(state) ? state.val : null;
  if (!isRecord(val)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(val)) {
    if (SECRET_METADATA_KEYS.has(key) || looksRedacted(value) || value === undefined || value === null) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** A Composio toolkit that supports their shared (managed) OAuth app. */
export interface ComposioToolkit {
  slug: string;
  name: string;
}

/** A Composio tool (executable action) within a toolkit — the fallback rail's unit. */
export interface ComposioToolDef {
  slug: string;
  name: string;
  /** `input_parameters.properties` keys — the argument names the tool accepts. */
  inputProperties: string[];
  /** Each argument's declared JSON-schema `type`, keyed by name — for value coercion. */
  inputTypes: Record<string, string>;
}

/** One Composio trigger TYPE (catalog row, ADR 0046) — the managed-subscription rail's unit. */
export interface ComposioTriggerType {
  slug: string;
  name: string;
  description: string;
  toolkitSlug: string;
  /** The trigger's config JSON-schema (`{ properties, required }`) — the picker parameters. */
  config: Record<string, unknown>;
  /** Composio delivery mode — `'poll'` | `'webhook'` (either way delivered to our project webhook). */
  type: string;
}

/** Result of `tools/execute`: `successful` gates data vs. the (string) error. */
export interface ComposioExecuteResult {
  successful: boolean;
  data: unknown;
  error: string | null;
}

/** A tool's `input_parameters.properties` as argument names + declared types; both empty when the schema is absent or malformed. */
function inputPropertySchema(inputParameters: unknown): {
  names: string[];
  types: Record<string, string>;
} {
  const props = isRecord(inputParameters) ? inputParameters.properties : null;
  if (!isRecord(props)) return { names: [], types: {} };
  const names = Object.keys(props);
  const types: Record<string, string> = {};
  for (const name of names) {
    const schema = props[name];
    if (isRecord(schema) && typeof schema.type === 'string') types[name] = schema.type;
  }
  return { names, types };
}

/** Composio's `error` can be a string or a `{ message }` object — normalise to a string. */
function normalizeExecuteError(error: unknown): string | null {
  if (typeof error === 'string') return error || null;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return null;
}

export type ManagedAccountStatus = 'pending' | 'active' | 'expired' | 'failed';

/** Composio itself failed (network, 5xx, unexpected shape) — a gateway problem, not the caller's. */
export class ComposioUpstreamError extends DomainError {
  constructor(message: string) {
    super(message, 502);
  }
}

/** A Composio 4xx rejection carrying the UPSTREAM status (so 404/410 can be read as already-gone); still a 400 to our API. */
export class ComposioRequestError extends DomainError {
  constructor(
    message: string,
    readonly upstreamStatus: number,
  ) {
    super(message, 400);
  }
}

/**
 * Thin client for Composio's v3 API — it only BROKERS auth (managed auth configs, connect links, account
 * status/deletion); execution goes through ComposioExecutionProvider. Inert until a Composio key is
 * set in Settings; the key is read per request, never snapshotted, so it takes effect immediately.
 */
@Injectable()
export class ComposioProvider {
  private readonly logger = new Logger(ComposioProvider.name);
  private readonly baseUrl: string;
  // Every cache is keyed by SCOPE: a Composio key addresses one project, so one scope's
  // catalog or account metadata must never be served to another.
  private readonly toolkitCache = new Map<string, { at: number; items: ComposioToolkit[] }>();
  private readonly metadataCache = new Map<string, { at: number; data: Record<string, unknown> }>();
  private readonly toolsCache = new Map<string, { at: number; items: ComposioToolDef[] }>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService<{ env: EnvConfig }, true>,
    // Optional so the provider stays `new`-able in unit tests without DI.
    @Optional() private readonly platformKeys?: PlatformKeysService,
  ) {
    const env = config.get('env', { infer: true });
    this.baseUrl = env.composioBaseUrl.replace(/\/+$/, '');
  }

  /** Whether THIS scope has a Composio key — the managed rail's on/off signal, asked per call. */
  async isConfigured(scope: PlatformKeyScope): Promise<boolean> {
    return (await this.apiKey(scope)) !== '';
  }

  private async apiKey(scope: PlatformKeyScope): Promise<string> {
    return (await this.platformKeys?.composioApiKey(scope)) ?? '';
  }

  /** Toolkits with a Composio-managed (shared) OAuth app, cached in-process. */
  async listManagedToolkits(scope: PlatformKeyScope): Promise<ComposioToolkit[]> {
    const cacheKey = scopeKey(scope);
    const cached = this.toolkitCache.get(cacheKey);
    if (cached && Date.now() - cached.at < TOOLKIT_CACHE_TTL_MS) return cached.items;
    const items: ComposioToolkit[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request(
        scope,
        'GET',
        `/api/v3/toolkits?limit=${TOOLKIT_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new ComposioUpstreamError('Composio toolkit listing returned an unexpected shape');
      }
      for (const raw of page.items) {
        if (!isRecord(raw) || typeof raw.slug !== 'string') continue;
        const managed = raw.composio_managed_auth_schemes;
        if (!Array.isArray(managed) || managed.length === 0) continue; // no shared app → BYO only
        items.push({ slug: raw.slug, name: typeof raw.name === 'string' ? raw.name : raw.slug });
      }
      cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
    } while (cursor);
    this.toolkitCache.set(cacheKey, { at: Date.now(), items });
    return items;
  }

  /**
   * The managed auth-config id for a toolkit: from our table, else adopted from an existing Composio-managed
   * config, else created. The winner is persisted so restarts reuse it; a concurrent create leaves a harmless orphan.
   */
  async ensureAuthConfig(scope: PlatformKeyScope, toolkitSlug: string): Promise<string> {
    const existing = await this.dataSource.manager.findOne(ComposioAuthConfigEntity, {
      where: { toolkitSlug },
    });
    if (existing) return existing.authConfigId;

    const authConfigId =
      (await this.findManagedAuthConfig(scope, toolkitSlug)) ??
      (await this.createManagedAuthConfig(scope, toolkitSlug));

    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(ComposioAuthConfigEntity)
      .values({ toolkitSlug, authConfigId, createdAt: now() })
      .orIgnore() // concurrent link calls: first insert wins
      .execute();
    const winner = await this.dataSource.manager.findOne(ComposioAuthConfigEntity, {
      where: { toolkitSlug },
    });
    return winner?.authConfigId ?? authConfigId;
  }

  /** Mint a hosted Connect Link for the user (managed configs REQUIRE this flow). */
  async createLink(
    scope: PlatformKeyScope,
    userId: string,
    authConfigId: string,
  ): Promise<{ redirectUrl: string; connectedAccountId: string }> {
    const body = await this.request(scope, 'POST', '/api/v3/connected_accounts/link', {
      auth_config_id: authConfigId,
      user_id: userId,
    });
    if (
      !isRecord(body) ||
      typeof body.redirect_url !== 'string' ||
      typeof body.connected_account_id !== 'string'
    ) {
      throw new ComposioUpstreamError('Composio connect-link response was missing redirect_url');
    }
    return { redirectUrl: body.redirect_url, connectedAccountId: body.connected_account_id };
  }

  /** Poll a connected account: INITIALIZING/INITIATED/PENDING → pending, ACTIVE → active, EXPIRED → expired, else failed. */
  async getAccountStatus(scope: PlatformKeyScope, connectedAccountId: string): Promise<ManagedAccountStatus> {
    const body = await this.request(
      scope,
      'GET',
      `/api/v3/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
    );
    const status = isRecord(body) && typeof body.status === 'string' ? body.status.toUpperCase() : '';
    if (status === 'ACTIVE') return 'active';
    if (status === 'INITIALIZING' || status === 'INITIATED' || status === 'PENDING') return 'pending';
    if (status === 'EXPIRED') return 'expired';
    return 'failed';
  }

  /** Delete the Composio connected account (revokes their custody of the grant). */
  async deleteAccount(scope: PlatformKeyScope, connectedAccountId: string): Promise<void> {
    await this.request(
      scope,
      'DELETE',
      `/api/v3/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
    );
  }

  /** The connected account's non-secret metadata for `auth.data.*`, cached per account; raw tokens are never surfaced. */
  async getAccountMetadata(
    scope: PlatformKeyScope,
    connectedAccountId: string,
  ): Promise<Record<string, unknown>> {
    const cacheKey = `${scopeKey(scope)}:${connectedAccountId}`;
    const cached = this.metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.at < METADATA_CACHE_TTL_MS) return cached.data;
    const body = await this.request(
      scope,
      'GET',
      `/api/v3/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
    );
    const data = extractAccountMetadata(body);
    this.metadataCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  /** A toolkit's executable tools, cached; deprecated tools are dropped so the matcher never resolves to a dead slug. */
  async listTools(scope: PlatformKeyScope, toolkitSlug: string): Promise<ComposioToolDef[]> {
    const cacheKey = `${scopeKey(scope)}:${toolkitSlug}`;
    const cached = this.toolsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < TOOLKIT_CACHE_TTL_MS) return cached.items;
    const items: ComposioToolDef[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request(
        scope,
        'GET',
        `/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=${TOOL_PAGE_LIMIT}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      );
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new ComposioUpstreamError('Composio tool listing returned an unexpected shape');
      }
      for (const raw of page.items) {
        if (!isRecord(raw) || typeof raw.slug !== 'string') continue;
        if (raw.is_deprecated === true || raw.deprecated === true) continue;
        const schema = inputPropertySchema(raw.input_parameters);
        items.push({
          slug: raw.slug,
          name: typeof raw.name === 'string' ? raw.name : raw.slug,
          inputProperties: schema.names,
          inputTypes: schema.types,
        });
      }
      cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
    } while (cursor);
    this.toolsCache.set(cacheKey, { at: Date.now(), items });
    return items;
  }

  /**
   * Execute one Composio tool against a connected account; `user_id` is REQUIRED alongside `connected_account_id`.
   * A tool that RAN but failed returns `{ successful: false, error }` on HTTP 200; transport/4xx/5xx raise via `request`.
   */
  async executeTool(
    scope: PlatformKeyScope,
    toolSlug: string,
    params: { connectedAccountId: string; userId: string; arguments: Record<string, unknown> },
  ): Promise<ComposioExecuteResult> {
    const body = await this.request(scope, 'POST', `/api/v3/tools/execute/${encodeURIComponent(toolSlug)}`, {
      connected_account_id: params.connectedAccountId,
      user_id: params.userId,
      arguments: params.arguments,
    });
    if (!isRecord(body)) {
      throw new ComposioUpstreamError('Composio tool execution returned an unexpected shape');
    }
    return {
      successful: body.successful === true,
      data: body.data,
      error: normalizeExecuteError(body.error),
    };
  }

  // ─── Trigger instances (ADR 0046 — the managed native-subscription rail) ───

  /**
   * Every Composio trigger TYPE, malformed rows dropped — the FULL trigger universe.
   * The "offered = subscribable" filter lives in {@link ComposioTriggerProvider.project}, not here.
   */
  async listTriggerTypes(scope: PlatformKeyScope): Promise<ComposioTriggerType[]> {
    const items: ComposioTriggerType[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request(
        scope,
        'GET',
        `/api/v3/triggers_types?limit=${TRIGGER_TYPE_PAGE_LIMIT}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      );
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new ComposioUpstreamError('Composio trigger-type listing returned an unexpected shape');
      }
      for (const raw of page.items) {
        if (!isRecord(raw) || typeof raw.slug !== 'string') continue;
        const toolkit = isRecord(raw.toolkit) ? raw.toolkit : {};
        const toolkitSlug = typeof toolkit.slug === 'string' ? toolkit.slug : '';
        if (!toolkitSlug) continue; // a trigger with no toolkit can't be app-namespaced
        items.push({
          slug: raw.slug,
          name: typeof raw.name === 'string' && raw.name ? raw.name : raw.slug,
          description: typeof raw.description === 'string' ? raw.description : '',
          toolkitSlug,
          config: isRecord(raw.config) ? raw.config : {},
          type: typeof raw.type === 'string' ? raw.type : '',
        });
      }
      cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
    } while (cursor);
    return items;
  }

  /**
   * Idempotent UPSERT of a Composio trigger INSTANCE (ADR 0046). Composio dedupes on
   * `(connected_account, slug, trigger_config)`, so identical activations SHARE an id — the caller must refcount teardown.
   */
  async createTriggerInstance(
    scope: PlatformKeyScope,
    params: {
      slug: string;
      connectedAccountId: string;
      userId: string;
      triggerConfig: Record<string, unknown>;
    },
  ): Promise<string> {
    const body = await this.request(
      scope,
      'POST',
      `/api/v3/trigger_instances/${encodeURIComponent(params.slug)}/upsert`,
      {
        connected_account_id: params.connectedAccountId,
        user_id: params.userId,
        trigger_config: params.triggerConfig,
      },
    );
    if (!isRecord(body) || typeof body.trigger_id !== 'string' || !body.trigger_id) {
      throw new ComposioUpstreamError('Composio trigger-instance upsert returned no trigger_id');
    }
    return body.trigger_id;
  }

  /** Every LIVE Composio trigger instance id on this project — the ADR 0046 orphan reaper diffs these against activation rows. */
  async listActiveTriggerInstanceIds(scope: PlatformKeyScope): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request(
        scope,
        'GET',
        `/api/v3/trigger_instances/active?limit=${TRIGGER_INSTANCE_PAGE_LIMIT}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      );
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new ComposioUpstreamError(
          'Composio active trigger-instance listing returned an unexpected shape',
        );
      }
      for (const raw of page.items) {
        const id = activeTriggerInstanceId(raw);
        if (id) ids.push(id);
      }
      cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
    } while (cursor);
    return ids;
  }

  /** Delete a trigger instance; an already-gone (404/410) one counts as success so a re-run can't wedge teardown. */
  async deleteTriggerInstance(scope: PlatformKeyScope, triggerId: string): Promise<void> {
    try {
      await this.request(
        scope,
        'DELETE',
        `/api/v3/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
      );
    } catch (err) {
      if (err instanceof ComposioRequestError && (err.upstreamStatus === 404 || err.upstreamStatus === 410)) {
        this.logger.log(
          `Composio trigger instance ${triggerId} already gone (${err.upstreamStatus}) — delete is a no-op`,
        );
        return;
      }
      throw err;
    }
  }

  private async findManagedAuthConfig(scope: PlatformKeyScope, toolkitSlug: string): Promise<string | null> {
    const body = await this.request(
      scope,
      'GET',
      `/api/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=100`,
    );
    if (!isRecord(body) || !Array.isArray(body.items)) return null;
    for (const raw of body.items) {
      if (isRecord(raw) && raw.is_composio_managed === true && typeof raw.id === 'string') {
        return raw.id;
      }
    }
    return null;
  }

  private async createManagedAuthConfig(scope: PlatformKeyScope, toolkitSlug: string): Promise<string> {
    const body = await this.request(scope, 'POST', '/api/v3/auth_configs', {
      toolkit: { slug: toolkitSlug },
      auth_config: { type: 'use_composio_managed_auth' },
    });
    const authConfig = isRecord(body) ? body.auth_config : null;
    if (!isRecord(authConfig) || typeof authConfig.id !== 'string') {
      throw new ComposioUpstreamError('Composio auth-config creation returned no id');
    }
    this.logger.log(`Created Composio managed auth config for "${toolkitSlug}": ${authConfig.id}`);
    return authConfig.id;
  }

  /** One request seam: auth, timeouts, JSON decode, and error mapping (4xx → DomainError 400, 5xx/network → 502). */
  private async request(
    scope: PlatformKeyScope,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const apiKey = await this.apiKey(scope);
    if (!apiKey) {
      throw new DomainError('Managed connections are not configured — add a Composio API key in Settings');
    }
    let statusCode: number;
    let text: string;
    try {
      const res = await request(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': apiKey,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      });
      statusCode = res.statusCode;
      text = await res.body.text();
    } catch (err) {
      const message = errorMessage(err);
      this.logger.warn(`Composio ${method} ${path} failed: ${message}`);
      throw new ComposioUpstreamError(`Composio request failed: ${message}`);
    }
    if (statusCode >= 500) {
      this.logger.warn(`Composio ${method} ${path} returned ${statusCode}: ${text.slice(0, 500)}`);
      throw new ComposioUpstreamError(`Composio returned ${statusCode}`);
    }
    if (statusCode >= 400) {
      this.logger.warn(`Composio ${method} ${path} returned ${statusCode}: ${text.slice(0, 500)}`);
      throw new ComposioRequestError(
        `Composio rejected the request (${statusCode}): ${text.slice(0, 300)}`,
        statusCode,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ComposioUpstreamError('Composio returned a non-JSON response');
    }
  }
}
