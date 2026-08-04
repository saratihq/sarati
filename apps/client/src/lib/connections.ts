import type { Connection } from "@/api/client";

/**
 * Only rows a step can actually run as. A pending/expired/failed row hard-errors at run time, so every
 * run-bound surface MUST filter through this before offering or auto-attaching. No status = active.
 */
export function activeConnections(connections: Connection[]): Connection[] {
  return connections.filter((c) => (c.status ?? "active") === "active");
}

/** Connections serving an app slug: exact provider match, or a family match (`google` → `google-sheets.*`). */
export function matchingConnections(connections: Connection[], appSlug: string | undefined): Connection[] {
  if (!appSlug) return [];
  return connections.filter((c) => c.provider === appSlug || appSlug.startsWith(`${c.provider}-`));
}

/**
 * What the Connection select offers: real matches ONLY — never fall back to every account, since a
 * wrong-app credential hard-errors at run time. Slug-less types can't be matched, so they see them all.
 */
export function candidateConnections(connections: Connection[], appSlug: string | undefined): Connection[] {
  return appSlug ? matchingConnections(connections, appSlug) : connections;
}

/** Human label for a connection option/row. */
export function connectionLabel(c: Connection): string {
  return c.display_name ? `${c.provider} · ${c.display_name}` : c.provider;
}

/** Human name for an app slug when the catalog name isn't at hand: "google-sheets" → "Google Sheets". */
export function appDisplayName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
