/**
 * Curated data + pure mappers shared by every writer of the Composio catalog, so
 * they cannot drift in how a param row is shaped or a name is pinned. No I/O.
 */

/** Vendor strings that must never reach a user-visible field. */
export const VENDOR_RE = /composio|activepieces/i;

/**
 * Curated display-NAME overrides, keyed by public `<app>.<action>` type — they
 * survive a full catalog regen. `linear.list_linear_teams` requires `project_id`,
 * so it lists the teams OF A PROJECT; the 0-arg lister is
 * `linear.get_all_linear_teams`.
 */
export const NAME_OVERRIDES = Object.freeze({
  'linear.list_linear_teams': 'Get teams by project',
});

/** The curated display name for a public type, or undefined to keep the tool's own. */
export function nameOverrideFor(type) {
  return Object.prototype.hasOwnProperty.call(NAME_OVERRIDES, type) ? NAME_OVERRIDES[type] : undefined;
}

/** Drop vendor-mentioning STRING enum values; keep non-strings (numbers/booleans). */
function cleanEnum(values) {
  if (!Array.isArray(values)) return undefined;
  const kept = values.filter((v) => !(typeof v === 'string' && VENDOR_RE.test(v)));
  return kept.length > 0 ? kept : undefined;
}

/**
 * The authoring-only param fields a catalog row carries beyond
 * type/description/required — `options`, `default`, `items`, `format`. Returns
 * only the keys present on `p`, in a STABLE order, so every writer serialises
 * byte-identically. User-visible strings are vendor-filtered like any other.
 */
export function extraParamFields(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  const options = cleanEnum(p.enum);
  if (options) out.options = options;
  if (Object.prototype.hasOwnProperty.call(p, 'default')) {
    const d = p.default;
    if (!(typeof d === 'string' && VENDOR_RE.test(d))) out.default = d;
  }
  if (p.items && typeof p.items === 'object') {
    const items = {};
    if (typeof p.items.type === 'string') items.type = p.items.type;
    const itemEnum = cleanEnum(p.items.enum);
    if (itemEnum) items.enum = itemEnum;
    if (Object.keys(items).length > 0) out.items = items;
  }
  if (typeof p.format === 'string' && p.format && !VENDOR_RE.test(p.format)) out.format = p.format;
  return out;
}

/** True if any surfaced string field of a param carries a vendor mention (final guard). */
export function paramVendorLeak(parameters) {
  const hasVendorString = (arr) =>
    Array.isArray(arr) && arr.some((v) => typeof v === 'string' && VENDOR_RE.test(v));
  for (const p of Object.values(parameters ?? {})) {
    if (!p || typeof p !== 'object') continue;
    if (hasVendorString(p.options)) return true;
    if (typeof p.default === 'string' && VENDOR_RE.test(p.default)) return true;
    if (typeof p.format === 'string' && VENDOR_RE.test(p.format)) return true;
    if (p.items && typeof p.items === 'object' && hasVendorString(p.items.enum)) return true;
  }
  return false;
}
