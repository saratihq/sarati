/**
 * The ONE place the client answers "are these two IR documents the same?" (constitution #4).
 * Byte-comparing documents is BANNED and lint-enforced — key order is not content.
 * Both keys sort, so neither can be fooled by serialization order.
 */
function canonical(doc: unknown, keepPositions: boolean): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sorted((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sorted(keepPositions ? doc : withoutLayout(doc)));
}

// Layout is a node's own `position`; a parameter or metadata field of that name is content.
function withoutLayout(doc: unknown): unknown {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const { nodes } = doc as { nodes?: unknown };
  if (!Array.isArray(nodes)) return doc;
  return {
    ...doc,
    nodes: nodes.map((node: unknown) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return node;
      const { position: _layout, ...content } = node as Record<string, unknown>;
      return content;
    }),
  };
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
