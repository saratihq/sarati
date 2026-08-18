import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { type Action, actions, type AuthScheme, type ManifestEntry } from '@sarati/actions-sdk';

import { errorMessage } from '../common/error-message';
import { dataFile } from '../generation/data-dir';

/** Merge-time curation counts are logged here (no DI — a standalone Logger). */
const logger = new Logger('SdkActionsRegistry');

/**
 * The SDK action REGISTRY + catalog projection, plus the Composio catalog projection (the universal fallback surface).
 * Deliberately DI-free so every seam that must agree on "ours vs. fallback" can import it; keyed by the PUBLIC
 * `<slug>.<action>` type a plan node's `actionId` carries, so resolution is an exact lookup, never a vendor guess.
 */

type AnyAction = Action<never, unknown>;
const CATALOG_ACTIONS = actions.catalogActions as unknown as readonly AnyAction[];

/** PUBLIC type → SDK action. Frozen at module load; the SDK catalog is static. */
const REGISTRY: ReadonlyMap<string, AnyAction> = new Map(
  CATALOG_ACTIONS.map((action) => [action.type, action]),
);

/** Whether a plan's action type resolves to one of OUR clean-room actions. */
export function isSdkActionType(type: string): boolean {
  return REGISTRY.has(type);
}

/** The SDK action for a public type, or undefined when none is ours. */
export function sdkAction(type: string): AnyAction | undefined {
  return REGISTRY.get(type);
}

/** The platform catalog-row shape (name/type/category/description/parameters/auth). */
export type CatalogEntry = Record<string, unknown>;

/** Project every SDK action to the platform catalog-row shape, so consumers treat ours identically to Composio rows. */
export function sdkCatalogEntries(): CatalogEntry[] {
  return CATALOG_ACTIONS.map((action) => manifestToCatalogEntry(action.toManifest(), action.auth));
}

/** The auth scheme as SERIALIZABLE wire metadata for the client's credential form — a `custom` scheme's `apply()` stays server-side. */
export function serializeAuthScheme(scheme: AuthScheme): Record<string, unknown> {
  switch (scheme.type) {
    case 'apiKey':
      return { type: 'apiKey', in: scheme.in, name: scheme.name, prefix: scheme.prefix ?? '' };
    case 'oauth2':
      return {
        type: 'oauth2',
        ...(scheme.authUrl ? { authUrl: scheme.authUrl } : {}),
        ...(scheme.tokenUrl ? { tokenUrl: scheme.tokenUrl } : {}),
        scopes: scheme.scopes ?? [],
      };
    case 'basic':
      return { type: 'basic' };
    case 'custom':
      return { type: 'custom' };
    case 'none':
      return { type: 'none' };
  }
}

function manifestToCatalogEntry(manifest: ManifestEntry, scheme: AuthScheme): CatalogEntry {
  const parameters: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(manifest.props)) {
    parameters[name] = {
      type: prop.type,
      description: prop.description ?? prop.displayName ?? '',
      required: prop.required,
      ...(prop.defaultValue !== undefined ? { defaultValue: prop.defaultValue } : {}),
      ...(prop.options ? { options: prop.options } : {}),
    };
  }
  return {
    name: manifest.displayName,
    type: manifest.type,
    category: manifest.type.slice(0, manifest.type.indexOf('.')),
    description: manifest.description,
    parameters,
    auth: manifest.authType === 'none' ? 'none' : 'connection',
    // Absent on Composio rows (managed) — the client shows a BYO form only where this is present.
    authScheme: serializeAuthScheme(scheme),
  };
}

/**
 * Apps for which we offer ONLY our own SDK actions, suppressing the Composio-catalog rows ("offered = works").
 * CATALOG slugs, not Composio toolkit names (`sheets` not `googlesheets`).
 */
const MANAGED_BROKEN_APPS: ReadonlySet<string> = new Set([
  'gmail',
  'sheets',
  'docs',
  'drive',
  'slides',
  'calendar',
]);

/** The app slug (category) of a public `<slug>.<action>` type — LENIENT: a dotless type is its own category. */
export function appSlugOf(type: string): string {
  const dot = type.indexOf('.');
  return dot > 0 ? type.slice(0, dot) : type;
}

/**
 * The app slug of a public `<slug>.<action>` type, VALIDATED — `null` unless the type is a
 * well-formed `<slug>.<name>`. This is the routing/slot-resolution answer; {@link appSlugOf} is the
 * catalog-grouping one. Keep them adjacent: one loosening the other is a routing bug.
 */
export function validatedAppSlug(type: string): string | null {
  const dot = type.indexOf('.');
  if (dot <= 0) return null;
  const slug = type.slice(0, dot);
  return /^[a-z][a-z0-9_-]*$/.test(slug) ? slug : null;
}

// ─── Composio universal fallback catalog ────────────────────────────────────

/**
 * The prebuilt Composio catalog (`data/composio_catalog.json`) — the file IS the source, never a runtime fetch.
 * Lazily loaded + cached; a missing/corrupt file degrades to an empty list rather than throwing into a request.
 */
let composioCatalogCache: CatalogEntry[] | null = null;
let composioTypeCache: Set<string> | null = null;

export function loadComposioCatalog(): CatalogEntry[] {
  if (composioCatalogCache) return composioCatalogCache;
  let entries: CatalogEntry[] = [];
  const path = dataFile(__dirname, 'composio_catalog.json');
  if (!path) {
    logger.warn(
      'composio_catalog.json not found — the Composio fallback catalog is EMPTY, so only SDK actions are offered',
    );
  } else {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) {
        entries = parsed.filter((e): e is CatalogEntry => e !== null && typeof e === 'object');
      } else {
        logger.warn(`${path} is not a JSON array — the Composio fallback catalog is EMPTY`);
      }
    } catch (err) {
      // Fail-open so a corrupt file degrades the catalog instead of throwing into a request.
      logger.warn(`Could not read ${path} (${errorMessage(err)}) — the Composio fallback catalog is EMPTY`);
    }
  }
  composioCatalogCache = entries;
  return entries;
}

function composioCatalogTypes(): Set<string> {
  composioTypeCache ??= new Set(loadComposioCatalog().map((e) => String(e.type)));
  return composioTypeCache;
}

/** The EXACT Composio tool a catalog action executes as (see {@link composioToolFor}). */
export interface ComposioCatalogTool {
  slug: string;
  inputProperties: string[];
  inputTypes: Record<string, string>;
  /** The arg names the schema marks `required: true` — the pre-flight validator's input. */
  required: string[];
}

let composioToolCache: Map<string, ComposioCatalogTool> | null = null;

/**
 * OUR action → the Composio catalog row that implements it, for actions Composio has no row of its own for.
 * Without an entry Composio NAME-MATCHES the action to a tool of its choosing: that is how `list_sheets` reached
 * a names-only tool and lost every tab's id and index.
 */
const COMPOSIO_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['sheets.list_sheets', 'sheets.get_spreadsheet_info'],
]);

/**
 * The EXACT Composio tool a catalog action executes as. Execution MUST route by this recorded slug, never by
 * re-deriving it from the public `type`. `undefined` (not a Composio row / no recorded slug) → caller uses the name matcher.
 */
export function composioToolFor(type: string): ComposioCatalogTool | undefined {
  if (!composioToolCache) {
    composioToolCache = new Map();
    for (const e of loadComposioCatalog()) {
      const slug = typeof e.composioSlug === 'string' ? e.composioSlug : '';
      if (!slug) continue;
      const params =
        e.parameters && typeof e.parameters === 'object' ? (e.parameters as Record<string, unknown>) : {};
      const inputTypes: Record<string, string> = {};
      const required: string[] = [];
      for (const [name, schema] of Object.entries(params)) {
        const declared =
          schema && typeof schema === 'object' ? (schema as { type?: unknown }).type : undefined;
        if (typeof declared === 'string') inputTypes[name] = declared;
        const isRequired =
          schema && typeof schema === 'object' ? (schema as { required?: unknown }).required : undefined;
        if (isRequired === true) required.push(name);
      }
      composioToolCache.set(String(e.type), {
        slug,
        inputProperties: Object.keys(params),
        inputTypes,
        required,
      });
    }
  }
  return composioToolCache.get(COMPOSIO_TOOL_ALIASES.get(type) ?? type);
}

/**
 * Whether `type` is an executable Composio-catalog action — the router's general-fallback gate.
 * Permissive by design (it covers EVERY managed-toolkit tool); the conservative SURFACING rule is {@link mergeComposioCatalog}.
 */
export function isComposioCatalogType(type: string): boolean {
  return composioCatalogTypes().has(type);
}

/**
 * Whether SOME execution rail claims this action type — the SINGLE definition both the router (run time) and the
 * version-write commit gate (save time) key on, so commit-reject ⟺ run-400. Deliberately the RUNNABLE set,
 * broader than the OFFER set ({@link mergeComposioCatalog}): a de-offered-but-runnable action must still commit.
 */
export function isRoutableActionType(type: string): boolean {
  return isSdkActionType(type) || isComposioCatalogType(type);
}

/**
 * A MUTATION verb (a write) in an action's post-dot name. The offerability gate keys on the VERB, never on
 * parameter count — reads may legitimately take no parameters, so a blanket 0-param drop would kill ~189 legit ones.
 */
const MUTATION_VERB_RE = /^(create|post|insert|upload|update|patch|put|send|add|delete|remove|set|replace)_/;

/** A well-formed public `<app>.<action>` id — the letter-first app slug + a snake action tail. */
const OFFERABLE_TYPE_RE = /^[a-z][a-z0-9_-]*\.[a-z0-9_]+$/;

/**
 * Whether a Composio catalog ROW is worth OFFERING: (a) well-formed id + non-empty `composioSlug`,
 * (b) not deprecated, (c) a mutation verb carries ≥1 parameter. Applied ONLY to Composio rows and ONLY to
 * the SURFACE — {@link loadComposioCatalog} stays unfiltered so already-authored nodes keep running.
 */
export function isOfferable(row: CatalogEntry): boolean {
  const type = typeof row.type === 'string' ? row.type : '';
  const composioSlug = typeof row.composioSlug === 'string' ? row.composioSlug : '';
  if (!OFFERABLE_TYPE_RE.test(type) || composioSlug === '') return false; // (a)
  const name = typeof row.name === 'string' ? row.name : '';
  const description = typeof row.description === 'string' ? row.description : '';
  if (/deprecat/i.test(name) || /^\s*\[deprecated\]/i.test(description)) return false; // (b)
  const action = type.slice(type.indexOf('.') + 1);
  const paramCount =
    row.parameters && typeof row.parameters === 'object' ? Object.keys(row.parameters).length : 0;
  if (MUTATION_VERB_RE.test(action) && paramCount === 0) return false; // (c) parameterless write
  return true;
}

/**
 * Fold the Composio catalog into the SDK catalog (the DISCOVERY surface), dedup strictly SDK > Composio:
 * drop (1) exact-type collisions, (2) every row of a {@link MANAGED_BROKEN_APPS} app, (3) non-{@link isOfferable} rows.
 * Execution routing is deliberately more permissive than this surface — see {@link isComposioCatalogType}.
 */
export function mergeComposioCatalog(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const composio = loadComposioCatalog();
  if (composio.length === 0) return [...entries];
  const existingTypes = new Set(entries.map((e) => String(e.type)));
  const survivors: CatalogEntry[] = [];
  let droppedNonOfferable = 0;
  for (const row of composio) {
    const type = String(row.type);
    if (existingTypes.has(type)) continue; // (1) an SDK action owns this exact id
    if (MANAGED_BROKEN_APPS.has(appSlugOf(type))) continue; // (2) curated Google apps → ours only
    if (!isOfferable(row)) {
      droppedNonOfferable += 1; // (3) structurally-broken → never offer
      continue;
    }
    survivors.push(row.source === 'composio' ? row : { ...row, source: 'composio' });
  }
  if (droppedNonOfferable > 0) {
    logger.log(
      `P1: dropped ${droppedNonOfferable} non-offerable Composio action(s) from the catalog surface`,
    );
  }
  return [...entries, ...survivors];
}
