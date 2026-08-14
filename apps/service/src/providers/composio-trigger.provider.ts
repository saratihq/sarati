import { Injectable, Logger } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { isRecord } from '../common/json-util';
import { ComposioProvider, type ComposioTriggerType } from '../connections/composio.provider';
import { toOurSlug } from '../connections/managed-connections.service';
import { verifyComposioWebhook, type ComposioWebhookVerifyResult } from './composio-webhook-verify';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';

/** The catalog cache TTL — the Composio trigger-type catalog is stable within a process. */
const CATALOG_TTL_MS = 10 * 60_000;
/** The SHORT TTL after a failed (or empty) refresh — back off, but recover within a minute rather than pinning a bad result. */
const CATALOG_NEGATIVE_TTL_MS = 45_000;

/** The picker row for a Composio-subscription trigger — the SAME wire shape every other trigger entry uses. */
export interface ComposioProjectedCatalogEntry {
  name: string;
  type: string;
  category: string;
  description: string;
  parameters: Record<string, unknown>;
  auth: 'connection';
}

interface CatalogCache {
  at: number;
  /** How long this cache entry is fresh — the full TTL for a good catalog, the short negative TTL for a failed/empty refresh. */
  ttl: number;
  entries: ComposioProjectedCatalogEntry[];
  /** PUBLIC type → the EXACT Composio trigger slug (ADR 0031 exact-slug: recorded, not re-derived). */
  slugByType: Map<string, string>;
}

/**
 * The Composio TRIGGER rail (ADR 0046) — projects Composio's trigger types into the picker and is the façade the
 * reconciler/intake drive to make them fire. Owns projection, caching, verification, and public-type↔slug mapping;
 * HTTP lives once in {@link ComposioProvider}. Inert (empty catalog, no subscribe) when `COMPOSIO_API_KEY` is unset.
 */
/** Cache partition per owning scope. */
function cacheKeyOf(scope: PlatformKeyScope): string {
  return scope.kind === 'user' ? `u:${scope.userId}` : `o:${scope.orgId}`;
}

@Injectable()
export class ComposioTriggerProvider {
  private readonly logger = new Logger(ComposioTriggerProvider.name);
  // Per-scope: a Composio key addresses one project, so one scope's catalog is not another's.
  private readonly cache = new Map<string, CatalogCache>();

  constructor(
    private readonly composio: ComposioProvider,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  /** Whether the managed trigger rail can run for this scope (a Composio key is stored). */
  async isConfigured(scope: PlatformKeyScope): Promise<boolean> {
    return this.composio.isConfigured(scope);
  }

  /** The projected picker rows, lazily cached; a Composio hiccup serves the stale cache (or `[]`), never throws. */
  async catalog(scope: PlatformKeyScope): Promise<ComposioProjectedCatalogEntry[]> {
    if (!(await this.isConfigured(scope))) return [];
    const cached = this.cache.get(cacheKeyOf(scope));
    if (cached && Date.now() - cached.at < cached.ttl) return cached.entries;
    try {
      const [types, managed] = await Promise.all([
        this.composio.listTriggerTypes(scope),
        this.managedToolkitSlugs(scope),
      ]);
      const projected = this.project(types, managed);
      if (projected.entries.length > 0) {
        this.cache.set(cacheKeyOf(scope), projected); // a good catalog — full TTL
        return projected.entries;
      }
      // An HTTP-200 with `items: []` is a transient blip — it must NOT overwrite a previously good cache.
      return this.negativeCache(scope);
    } catch (err) {
      this.logger.warn(`Composio trigger catalog refresh failed: ${errorMessage(err)}`);
      return this.negativeCache(scope);
    }
  }

  /** Keep the last-known entries/slugs but re-check soon (short TTL) — the failed/empty-refresh path. */
  private negativeCache(scope: PlatformKeyScope): ComposioProjectedCatalogEntry[] {
    const key = cacheKeyOf(scope);
    const prev = this.cache.get(key);
    const entries = prev?.entries ?? [];
    this.cache.set(key, {
      at: Date.now(),
      ttl: CATALOG_NEGATIVE_TTL_MS,
      entries,
      slugByType: prev?.slugByType ?? new Map<string, string>(),
    });
    return entries;
  }

  /**
   * The EXACT Composio trigger slug for a PUBLIC `<app>.<trigger>` type — the recorded one from a warm catalog
   * (ADR 0031), else the deterministic uppercase reversal so subscribe never forces a fetch; `null` only if malformed.
   */
  slugForPublicType(publicType: string): string | null {
    const dot = publicType.indexOf('.');
    if (dot <= 0) return null;
    // Any warm scope's mapping is a valid hint — the slug is Composio's, not the project's —
    // and the deterministic reversal below is the answer when none is warm.
    for (const entry of this.cache.values()) {
      const recorded = entry.slugByType.get(publicType);
      if (recorded) return recorded;
    }
    return publicType.slice(dot + 1).toUpperCase();
  }

  /** Subscribe: create (idempotent upsert) the Composio trigger instance; returns its id. */
  createTriggerInstance(
    scope: PlatformKeyScope,
    params: {
      slug: string;
      connectedAccountId: string;
      userId: string;
      triggerConfig: Record<string, unknown>;
    },
  ): Promise<string> {
    return this.composio.createTriggerInstance(scope, params);
  }

  /** Unsubscribe: delete the Composio trigger instance (best-effort teardown). */
  deleteTriggerInstance(scope: PlatformKeyScope, triggerId: string): Promise<void> {
    return this.composio.deleteTriggerInstance(scope, triggerId);
  }

  /**
   * Every LIVE Composio trigger-instance id — the truth the ADR 0046 reaper diffs against the activation rows.
   * A hiccup yields `[]` rather than throwing, so a transient failure can never read as "everything is orphaned".
   */
  async listActiveInstanceIds(scope: PlatformKeyScope): Promise<string[]> {
    if (!(await this.isConfigured(scope))) return [];
    try {
      return await this.composio.listActiveTriggerInstanceIds(scope);
    } catch (err) {
      this.logger.warn(`Composio active trigger-instance listing failed: ${errorMessage(err)}`);
      return [];
    }
  }

  /**
   * Verify a delivery against THIS scope's stored webhook secret. Fails CLOSED when the scope
   * has none — an unverifiable delivery never fires, whichever scope it claims to be for.
   */
  async verifyWebhook(
    scope: PlatformKeyScope,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<ComposioWebhookVerifyResult> {
    const secret = (await this.platformKeys.get(scope, 'composio_webhook_secret')) ?? '';
    return verifyComposioWebhook(rawBody, headers, secret);
  }

  /**
   * The MANAGED Composio toolkit slugs — the only ones a Composio trigger can ever subscribe.
   * FAIL-OPEN: `null` (not an empty set) when undetermined, which {@link project} reads as "don't filter" —
   * a dead trigger offered is a papercut, an empty picker from an upstream hiccup is an outage.
   */
  private async managedToolkitSlugs(scope: PlatformKeyScope): Promise<Set<string> | null> {
    try {
      const toolkits = await this.composio.listManagedToolkits(scope);
      if (toolkits.length === 0) return null; // empty → treat as undetermined (fail open)
      return new Set(toolkits.map((t) => t.slug));
    } catch (err) {
      this.logger.warn(
        `Composio managed-toolkit fetch failed — trigger filter fails open: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /**
   * Project trigger types → picker rows + the public-type→slug map, intersected against the MANAGED toolkits so the
   * picker only offers subscribable triggers; a `null` managed set skips the intersection (fail-open).
   */
  private project(types: ComposioTriggerType[], managedToolkitSlugs: Set<string> | null): CatalogCache {
    const entries: ComposioProjectedCatalogEntry[] = [];
    const slugByType = new Map<string, string>();
    let droppedNonManaged = 0;
    for (const t of types) {
      // A toolkit with no shared managed OAuth app can never fire — no connection can subscribe it.
      if (managedToolkitSlugs && !managedToolkitSlugs.has(t.toolkitSlug)) {
        droppedNonManaged += 1;
        continue;
      }
      const app = toOurSlug(t.toolkitSlug);
      const type = `${app}.${t.slug.toLowerCase()}`;
      if (slugByType.has(type)) continue; // one row per public type (first slug wins)
      slugByType.set(type, t.slug);
      entries.push({
        name: t.name,
        type,
        category: app,
        description: t.description,
        parameters: projectParameters(t.config),
        auth: 'connection',
      });
    }
    if (droppedNonManaged > 0) {
      this.logger.log(
        `P1: dropped ${droppedNonManaged} non-managed Composio trigger(s) — toolkit has no shared managed OAuth app`,
      );
    }
    return { at: Date.now(), ttl: CATALOG_TTL_MS, entries, slugByType };
  }
}

/** A trigger's config JSON-schema → the picker's parameter shape, mapping schema types onto the picker's field vocabulary. */
function projectParameters(config: Record<string, unknown>): Record<string, unknown> {
  const props = isRecord(config.properties) ? config.properties : {};
  const required = Array.isArray(config.required)
    ? new Set(config.required.filter((r): r is string => typeof r === 'string'))
    : new Set<string>();
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(props)) {
    if (!isRecord(raw)) continue;
    const param: Record<string, unknown> = {
      type: fieldType(raw.type),
      description: typeof raw.description === 'string' ? raw.description : '',
      required: required.has(name),
    };
    if (raw.default !== undefined) param.default = raw.default;
    // A JSON-schema `enum` is a closed choice set — surface it as a dropdown, not a raw token field.
    const enumValues = Array.isArray(raw.enum)
      ? raw.enum.filter(
          (v): v is string | number | boolean =>
            typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        )
      : [];
    if (enumValues.length > 0) {
      param.type = 'DROPDOWN';
      param.options = enumValues.map((v) => ({ label: String(v), value: v }));
    }
    out[name] = param;
  }
  return out;
}

function fieldType(jsonSchemaType: unknown): string {
  switch (jsonSchemaType) {
    case 'number':
    case 'integer':
      return 'NUMBER';
    case 'boolean':
      return 'BOOLEAN';
    default:
      return 'SHORT_TEXT'; // string / array / object / unknown → a text field
  }
}
