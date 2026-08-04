/**
 * The ONE place the client answers "are these two IR documents the same?" (constitution #4).
 * Byte-comparing documents is BANNED and lint-enforced — key order is not content.
 * Both keys sort, so neither can be fooled by serialization order.
 */
function canonical(doc: unknown, keepPositions: boolean): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        if (key === "position" && !keepPositions) continue;
        out[key] = strip((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(doc));
}

/** Content identity: key order and node coordinates ignored. */
export function irContentKey(doc: unknown): string {
  return canonical(doc, false);
}

/**
 * Canvas identity: content PLUS layout. A pure node move leaves the CONTENT key equal, so the
 * co-editing fast path needs this or an incoming agent doc overwrites the move the person just made.
 */
export function irCanvasKey(doc: unknown): string {
  return canonical(doc, true);
}
