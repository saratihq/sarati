#!/usr/bin/env node
/**
 * Build-time Composio catalog extraction — run from apps/service:
 * `pnpm catalog:build:composio`.
 *
 * Writes `data/composio_catalog.json`: every executable tool of every managed-auth
 * toolkit, in the public `"<slug>.<action>"` row shape. The file is committed, so
 * no catalog fetch ever happens at runtime. It uses the same v3 endpoints and
 * paging as `src/connections/composio.provider.ts` — keep the two in sync.
 *
 * Contract:
 *  - Only MANAGED-AUTH toolkits (non-empty `composio_managed_auth_schemes`) are
 *    included — a managed connection is the only rail Composio execution runs on,
 *    so "offered = works" holds.
 *  - NON_EXECUTABLE managed apps are excluded: never surface a tool no rail runs.
 *  - Deprecated tools are dropped (the runtime matcher must never hit a dead slug).
 *  - NON-OFFERABLE rows are dropped (`isOfferable`, mirrored from
 *    src/providers/sdk-actions.registry.ts): rows that render valid but die at
 *    runtime never enter the catalog.
 *  - Toolkit slugs are normalised to OUR app slug where they differ, so ids dedup
 *    and round-trip through `toComposioSlug` at execution time.
 *  - The vendor's name never enters a user-visible field; the internal
 *    `source:"composio"` tag is the one intentional exception.
 *  - Output is deterministic (toolkits sorted by slug, tools by slug).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extraParamFields,
  nameOverrideFor,
  paramVendorLeak,
  VENDOR_RE,
} from './composio-catalog-fields.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = dirname(dirname(SELF));
const ENV_PATH = join(REPO, '.env');
const CATALOG_PATH = join(REPO, 'data', 'composio_catalog.json');

const REQUEST_TIMEOUT_MS = 20_000;
const TOOLKIT_PAGE_LIMIT = 1000; // Composio caps toolkit pages at 1000.
const TOOL_PAGE_LIMIT = 100;
const TOOLKIT_CONCURRENCY = 6; // I/O-bound HTTP fan-out.

/**
 * Composio toolkit slug → OUR app slug, where they differ — the INVERSE of
 * COMPOSIO_TOOLKIT_ALIASES in src/connections/managed-connections.service.ts; both
 * directions must agree. `outlook` is deliberately absent (identity, not
 * `outlook-calendar`).
 */
const TOOLKIT_TO_SLUG = {
  googlebigquery: 'bigquery',
  googlecalendar: 'calendar',
  kit: 'convertkit',
  googledocs: 'docs',
  googledrive: 'drive',
  facebook: 'facebook-pages',
  google_chat: 'google-chat',
  one_drive: 'onedrive',
  share_point: 'sharepoint',
  googlesheets: 'sheets',
  googleslides: 'slides',
  googletasks: 'tasks',
  microsoft_teams: 'teams',
  zoho: 'zoho-crm',
};

/**
 * Managed-catalog apps NEITHER rail can execute — mirrors
 * NON_EXECUTABLE_MANAGED_APPS in src/connections/managed-app-rails.ts. An entry
 * only belongs here with live evidence that execution fails.
 */
const NON_EXECUTABLE = new Set();

/** Our public slug rule (letter-first) — the compiler's PUBLIC_ACTION_TYPE. */
const SLUG_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Offerability — mirrors `isOfferable` in src/providers/sdk-actions.registry.ts
 * (keep the two in sync). A row is offerable iff: (a) well-formed `<app>.<action>`
 * id + a non-empty composioSlug; (b) not deprecated; (c) a MUTATION-verb action
 * carries ≥1 parameter — reads may be parameterless, so the gate is the VERB and
 * never a blanket 0-param drop.
 */
const MUTATION_VERB_RE = /^(create|post|insert|upload|update|patch|put|send|add|delete|remove|set|replace)_/;
const OFFERABLE_TYPE_RE = /^[a-z][a-z0-9_-]*\.[a-z0-9_]+$/;

function isOfferable(row) {
  const type = typeof row.type === 'string' ? row.type : '';
  const composioSlug = typeof row.composioSlug === 'string' ? row.composioSlug : '';
  if (!OFFERABLE_TYPE_RE.test(type) || composioSlug === '') return false; // (a)
  const name = typeof row.name === 'string' ? row.name : '';
  const description = typeof row.description === 'string' ? row.description : '';
  if (/deprecat/i.test(name) || /^\s*\[deprecated\]/i.test(description)) return false; // (b)
  const action = type.slice(type.indexOf('.') + 1);
  const paramCount = row.parameters && typeof row.parameters === 'object' ? Object.keys(row.parameters).length : 0;
  if (MUTATION_VERB_RE.test(action) && paramCount === 0) return false; // (c) parameterless write
  return true;
}

// ─── env + http ───

function readApiKey() {
  let key = process.env.COMPOSIO_API_KEY ?? '';
  let base = process.env.COMPOSIO_BASE_URL ?? '';
  try {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'COMPOSIO_API_KEY' && !key) key = m[2].trim();
      if (m[1] === 'COMPOSIO_BASE_URL' && !base) base = m[2].trim();
    }
  } catch {
    // no .env — rely on process.env
  }
  if (!key) {
    console.error('FATAL: COMPOSIO_API_KEY is not set (.env or environment).');
    process.exit(1);
  }
  return { key, base: (base || 'https://backend.composio.dev').replace(/\/+$/, '') };
}

const { key: API_KEY, base: BASE_URL } = readApiKey();

async function get(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'x-api-key': API_KEY, accept: 'application/json' },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ─── extraction ───

/** Managed-auth toolkits (non-empty composio_managed_auth_schemes), paged. */
async function listManagedToolkits() {
  const items = [];
  let cursor = null;
  do {
    const page = await get(
      `/api/v3/toolkits?limit=${TOOLKIT_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!Array.isArray(page.items)) throw new Error('toolkit listing returned an unexpected shape');
    for (const raw of page.items) {
      if (!raw || typeof raw.slug !== 'string') continue;
      const managed = raw.composio_managed_auth_schemes;
      if (!Array.isArray(managed) || managed.length === 0) continue; // no shared app → BYO-only
      items.push({ slug: raw.slug, name: typeof raw.name === 'string' ? raw.name : raw.slug });
    }
    cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
  } while (cursor);
  return items;
}

/** Executable (non-deprecated) tools of a toolkit, paged. */
async function listTools(toolkitSlug) {
  const items = [];
  let cursor = null;
  do {
    const page = await get(
      `/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=${TOOL_PAGE_LIMIT}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    );
    if (!Array.isArray(page.items)) throw new Error(`tool listing for "${toolkitSlug}" was malformed`);
    for (const raw of page.items) {
      if (!raw || typeof raw.slug !== 'string') continue;
      if (raw.is_deprecated === true) continue;
      items.push(raw);
    }
    cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
  } while (cursor);
  return items;
}

/** The action-name tail of a Composio tool slug: drop the toolkit prefix, lower-case. */
function actionNameOf(toolSlug, composioToolkitSlug) {
  const prefix = `${composioToolkitSlug.toUpperCase()}_`;
  const tail = toolSlug.toUpperCase().startsWith(prefix) ? toolSlug.slice(prefix.length) : toolSlug;
  return tail.toLowerCase();
}

let scrubbed = 0;
function scrub(text) {
  if (typeof text === 'string' && VENDOR_RE.test(text)) {
    scrubbed += 1;
    return '';
  }
  return typeof text === 'string' ? text : '';
}

/** Project one raw Composio tool → a public catalog row. */
function toCatalogRow(raw, ourSlug, composioToolkitSlug) {
  const input = raw.input_parameters && typeof raw.input_parameters === 'object' ? raw.input_parameters : {};
  const required = new Set(Array.isArray(input.required) ? input.required : []);
  const parameters = {};
  const props = input.properties && typeof input.properties === 'object' ? input.properties : {};
  for (const [propName, prop] of Object.entries(props)) {
    const p = prop && typeof prop === 'object' ? prop : {};
    parameters[propName] = {
      type: typeof p.type === 'string' ? p.type : 'unknown',
      description: scrub(p.description ?? p.title ?? ''),
      required: required.has(propName),
      ...extraParamFields(p),
    };
  }
  const type = `${ourSlug}.${actionNameOf(raw.slug, composioToolkitSlug)}`;
  return {
    name: nameOverrideFor(type) || scrub(raw.name) || type,
    type,
    category: ourSlug,
    description: scrub(raw.description),
    parameters,
    auth: raw.no_auth === true ? 'none' : 'connection',
    source: 'composio',
    // Execution routes by this exact slug — re-deriving it from `type` is lossy.
    composioSlug: raw.slug,
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ─── main ───

console.log(`Fetching managed-auth toolkits from ${BASE_URL} …`);
const toolkits = (await listManagedToolkits()).sort((a, b) => a.slug.localeCompare(b.slug));
console.log(`${toolkits.length} managed-auth toolkits.`);

const rows = [];
const results = await mapWithConcurrency(toolkits, TOOLKIT_CONCURRENCY, async (tk) => {
  const ourSlug = TOOLKIT_TO_SLUG[tk.slug] ?? tk.slug;
  if (!SLUG_RE.test(ourSlug))
    return { slug: tk.slug, kept: 0, status: `SKIP: slug "${ourSlug}" not addressable` };
  if (NON_EXECUTABLE.has(ourSlug))
    return { slug: tk.slug, kept: 0, status: 'SKIP: non-executable managed app' };
  let tools;
  try {
    tools = await listTools(tk.slug);
  } catch (err) {
    return { slug: tk.slug, kept: 0, status: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const raw of tools.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const row = toCatalogRow(raw, ourSlug, tk.slug);
    if (seen.has(row.type)) continue; // two tool slugs collapsing to one action name — keep first
    seen.add(row.type);
    if (!isOfferable(row)) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  return { slug: tk.slug, ourSlug, rows: kept, kept: kept.length, dropped, status: 'ok' };
});

const table = [];
let totalDropped = 0;
for (const r of results) {
  if (r.rows) rows.push(...r.rows);
  totalDropped += r.dropped ?? 0;
  table.push({ slug: r.slug, ourSlug: r.ourSlug ?? '-', kept: r.kept, status: r.status });
}

// Deterministic order: by public type. Rows are already normalised to our slug.
rows.sort((a, b) => a.type.localeCompare(b.type));

// Vendor never leaks into a user-visible FIELD (the source tag is intentional) —
// name/description AND the surfaced param strings (enum options / format / default).
for (const row of rows) {
  if (VENDOR_RE.test(row.name) || VENDOR_RE.test(row.description) || paramVendorLeak(row.parameters)) {
    console.error(`FATAL: vendor string survived scrubbing in ${row.type} — refusing to write.`);
    process.exit(1);
  }
}
if (rows.length === 0) {
  console.error('FATAL: no toolkit produced any tool — refusing to write an empty catalog.');
  process.exit(1);
}

writeFileSync(CATALOG_PATH, `${JSON.stringify(rows, null, 2)}\n`);

// ─── summary ───
const slugW = Math.max(...table.map((r) => r.slug.length), 8);
const ourW = Math.max(...table.map((r) => String(r.ourSlug).length), 6);
console.log(`\n${'toolkit'.padEnd(slugW)}  ${'ourSlug'.padEnd(ourW)}  tools  status`);
for (const r of table.sort((a, b) => a.slug.localeCompare(b.slug))) {
  console.log(
    `${r.slug.padEnd(slugW)}  ${String(r.ourSlug).padEnd(ourW)}  ${String(r.kept).padStart(5)}  ${r.status}`,
  );
}
const includedToolkits = table.filter((r) => r.status === 'ok').length;
console.log(
  `\n${includedToolkits} toolkits → ${rows.length} executable tools ` +
    `(${totalDropped} non-offerable rows dropped, ${scrubbed} vendor-mentioning fields dropped)`,
);
console.log(`wrote ${CATALOG_PATH}`);
