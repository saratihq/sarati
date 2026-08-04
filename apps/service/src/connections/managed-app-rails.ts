/**
 * Which execution rail each managed app runs on. The classification is STATIC — a deterministic allowlist, never a
 * per-request live probe. An app absent from every set below runs on the SDK rail.
 */

/** TRANSPORT-GAP apps whose auth shape the SDK rail can't carry: a managed connection must execute via Composio. */
export const FALLBACK_ONLY_APPS: ReadonlySet<string> = new Set([
  'convertkit',
  'intercom',
  'jira',
  'mailchimp',
  'trello',
  'whatsapp',
  'zendesk',
]);

/**
 * Apps whose every action on a MANAGED connection executes via Composio, checked BEFORE the SDK rail (Google rejects
 * the SDK's proxy leg for them). BYO/direct connections keep the SDK rail. CATALOG slugs (`sheets`, not `googlesheets`).
 */
export const COMPOSIO_DIRECT_APPS: ReadonlySet<string> = new Set([
  'calendar',
  'docs',
  'drive',
  'gmail',
  'sheets',
]);

/** Must a MANAGED connection execute via Composio even where an SDK action exists? Checked before every other rail. */
export function isComposioDirectApp(appSlug: string): boolean {
  return COMPOSIO_DIRECT_APPS.has(appSlug);
}

/** Blocklist of apps NEITHER rail can execute — add a slug only with a failing live probe behind it. */
export const NON_EXECUTABLE_MANAGED_APPS: ReadonlySet<string> = new Set<string>();

/** Does this managed app execute? The picker gates the connect grid to executable-only apps on it. */
export function isExecutableApp(appSlug: string): boolean {
  return !NON_EXECUTABLE_MANAGED_APPS.has(appSlug);
}

/** Must a MANAGED connection route through Composio rather than the SDK rail? `extra` is the deploy-time override. */
export function mustUseComposioFallback(appSlug: string, extra?: ReadonlySet<string>): boolean {
  return FALLBACK_ONLY_APPS.has(appSlug) || (extra?.has(appSlug) ?? false);
}

/** Parse the COMPOSIO_FALLBACK_APPS override (comma/space list) into a slug set. */
export function parseFallbackOverride(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}
