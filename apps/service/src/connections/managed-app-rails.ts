/**
 * Which execution rail each managed app runs on. The classification is STATIC — a deterministic allowlist, never a
 * per-request live probe. An app absent from every set below runs on the SDK rail.
 */

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

/**
 * Must a MANAGED connection execute via Composio even where an SDK action exists? Checked before every other rail.
 * `override` is the operator's COMPOSIO_FALLBACK_APPS list, which joins this set.
 */
export function isComposioDirectApp(appSlug: string, override?: ReadonlySet<string>): boolean {
  return COMPOSIO_DIRECT_APPS.has(appSlug) || (override?.has(appSlug) ?? false);
}

/** Blocklist of apps NEITHER rail can execute — add a slug only with a failing live probe behind it. */
export const NON_EXECUTABLE_MANAGED_APPS: ReadonlySet<string> = new Set<string>();

/** Does this managed app execute? The picker gates the connect grid to executable-only apps on it. */
export function isExecutableApp(appSlug: string): boolean {
  return !NON_EXECUTABLE_MANAGED_APPS.has(appSlug);
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
