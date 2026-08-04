// The one place display formats live. All helpers take ISO strings and degrade to an em dash on bad input.

const DASH = "—";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Jan 5, 2026" — lists and metadata where the day matters. */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return DASH;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "420ms" / "3.2s" / "2m 14s" / "1h 4m" — run durations from milliseconds. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Casing fixes for schema keys that would otherwise title-case awkwardly.
const KEY_ACRONYMS: Record<string, string> = {
  id: "ID",
  ids: "IDs",
  url: "URL",
  urls: "URLs",
  uri: "URI",
  api: "API",
  json: "JSON",
  html: "HTML",
  csv: "CSV",
  sql: "SQL",
  ip: "IP",
  ms: "ms",
  rss: "RSS",
};

/** "channel_id" / "channelId" → "Channel ID" — config-form labels from schema keys. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s.]+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((w) => {
      const lower = w.toLowerCase();
      return KEY_ACRONYMS[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** "just now" / "5m ago" / "3h ago" / "2d ago", falling back to formatDate past a week. */
export function timeAgo(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return DASH;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}
