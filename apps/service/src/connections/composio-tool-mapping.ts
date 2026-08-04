/**
 * Public action (`<app>.<action>`) ↔ Composio tool-slug mapping — a stemmed token match plus a verb-class guard.
 * Pure and deterministic; returns `null` when nothing matches cleanly rather than ever picking a silent wrong tool.
 */

/** The Composio tool fields the matcher/translator need (from `listTools`). */
export interface ComposioToolShape {
  /** UPPERCASE_UNDERSCORE tool slug, e.g. `SLACK_LIST_ALL_USERS`. */
  slug: string;
  /** Human name, e.g. `List all users`. */
  name: string;
  /** `input_parameters.properties` keys — the argument names the tool accepts. */
  inputProperties: string[];
  /** Each argument's declared JSON-schema `type`, keyed as `inputProperties` — the translator's coercion input. */
  inputTypes?: Record<string, string>;
  /** The schema-REQUIRED argument names, for the executor's pre-flight; carried only by the prebuilt-catalog path. */
  required?: string[];
}

export interface ToolMatch {
  slug: string;
  inputProperties: string[];
  /** Declared JSON-schema type per argument name (see {@link ComposioToolShape}). */
  inputTypes?: Record<string, string>;
  /** Required argument names (see {@link ComposioToolShape.required}). */
  required?: string[];
}

export interface PropTranslation {
  /** Our props re-keyed to the tool's argument names. */
  arguments: Record<string, unknown>;
  /** Our prop names with no argument counterpart on the tool (logged, not sent). */
  dropped: string[];
  /** Args left unhealed against a non-string declared type — sent as-is, but surfaced on the honesty channel. */
  coercionSkipped: string[];
}

/** Filler tokens that carry no matching signal (articles, prepositions, REST-slug `id`/`by` scaffolding). */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'for',
  'with',
  'in',
  'on',
  'and',
  'or',
  'from',
  'by',
  'id',
  'ids',
  's',
]);

/** Verb synonym classes — the guard that stops `delete_card` matching a `get_card` tool (same nouns, opposite intent). */
const VERB_CLASS: Record<string, string> = {};
for (const [cls, verbs] of Object.entries<string[]>({
  read: ['get', 'retrieve', 'fetch', 'read', 'list', 'find', 'search', 'lookup', 'download', 'view'],
  create: ['create', 'add', 'send', 'post', 'insert', 'upload', 'schedule', 'share', 'invite'],
  update: ['update', 'edit', 'modify', 'set', 'change', 'rename', 'patch', 'move', 'assign'],
  remove: ['delete', 'remove', 'archive', 'clear', 'revoke', 'unarchive', 'disable'],
})) {
  for (const v of verbs) VERB_CLASS[v] = cls;
}

/** Light singularisation so `users↔user`, `cards↔card`, `sends↔send` unify. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Split camelCase / snake / kebab into lowercase stemmed tokens, minus fillers. */
export function tokenize(raw: string): string[] {
  const tokens = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
    .map(stem)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

function verbClassOf(tokens: string[]): string | null {
  for (const t of tokens) {
    const cls = VERB_CLASS[t];
    if (cls) return cls;
  }
  return null;
}

/**
 * Best Composio tool for our `<action>` within a toolkit, or `null` when nothing matches cleanly: weighted recall +
 * precision + a same-verb-class bonus, disqualifying a contradicting verb class or zero object-noun overlap.
 */
export function matchTool(
  actionName: string,
  toolkitSlug: string,
  tools: ComposioToolShape[],
): ToolMatch | null {
  const action = tokenize(actionName);
  if (action.length === 0) return null;
  const actionVerb = verbClassOf(action);
  const objectTokens = action.filter((t) => !VERB_CLASS[t]);
  const toolkitTokens = new Set(tokenize(toolkitSlug));

  const scored: Array<{ tool: ComposioToolShape; score: number }> = [];
  for (const tool of tools) {
    const slugTokens = tokenize(tool.slug).filter((t) => !toolkitTokens.has(t));
    const tokens =
      slugTokens.length > 0 ? slugTokens : tokenize(tool.name).filter((t) => !toolkitTokens.has(t));
    if (tokens.length === 0) continue;

    const toolVerb = verbClassOf(tokens);
    if (actionVerb && toolVerb && actionVerb !== toolVerb) continue; // verb-class guard

    const overlap = action.filter((t) => tokens.includes(t)).length;
    if (overlap === 0) continue;
    // Must share at least one object noun (a pure verb match is not a match).
    if (objectTokens.length > 0 && objectTokens.every((t) => !tokens.includes(t))) continue;

    const recall = overlap / action.length;
    if (recall < 0.5) continue;
    const precision = overlap / tokens.length;
    const verbBonus = actionVerb && toolVerb && actionVerb === toolVerb ? 0.5 : 0;
    scored.push({ tool, score: recall * 2 + precision + verbBonus });
  }
  if (scored.length === 0) return null;

  scored.sort(
    (a, b) =>
      b.score - a.score || a.tool.slug.length - b.tool.slug.length || a.tool.slug.localeCompare(b.tool.slug),
  );
  const winner = scored[0]!.tool;
  return {
    slug: winner.slug,
    inputProperties: winner.inputProperties,
    ...(winner.inputTypes ? { inputTypes: winner.inputTypes } : {}),
    ...(winner.required ? { required: winner.required } : {}),
  };
}

/** Normalise a prop/arg name to a comparison key (camel + snake collapse). */
function normalizeArgName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** The declared types {@link coerceToDeclaredType} can heal a string into — a leftover string against one is a genuine miss. */
const COERCIBLE_TYPES = new Set(['integer', 'number', 'boolean', 'array', 'object']);

/**
 * Heal a STRING into the argument's declared JSON-schema type, but only when the conversion is UNAMBIGUOUS.
 * Anything else is left as-is so the tool's own validation surfaces the real problem — never a mangled guess.
 */
function coerceToDeclaredType(value: unknown, declaredType: string | undefined): unknown {
  if (typeof value !== 'string' || !declaredType) return value;
  const text = value.trim();
  if (declaredType === 'integer') {
    if (!/^[+-]?\d+$/.test(text)) return value;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : value;
  }
  if (declaredType === 'number') {
    if (text === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return value;
    const n = Number(text);
    return Number.isFinite(n) ? n : value;
  }
  if (declaredType === 'boolean') {
    const low = text.toLowerCase();
    if (low === 'true' || low === '1' || low === 'yes') return true;
    if (low === 'false' || low === '0' || low === 'no') return false;
    return value;
  }
  if (declaredType === 'array' || declaredType === 'object') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return value; // not JSON — leave it for the tool to reject
    }
    if (declaredType === 'array') return Array.isArray(parsed) ? parsed : value;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  }
  return value;
}

/**
 * Re-key our node props to the tool's argument names; a prop with no counterpart is DROPPED and reported.
 * EXACT-name-match-first is load-bearing: two args collapsing to the same normalized key would otherwise re-key a
 * supplied value onto the wrong arg, invisibly. The normalized fallback map is first-write-wins for the same reason.
 */
export function translateProps(
  props: Record<string, unknown>,
  toolInputProperties: string[],
  declaredTypes?: Record<string, string>,
): PropTranslation {
  const exact = new Set(toolInputProperties);
  const byNormalized = new Map<string, string>();
  for (const name of toolInputProperties) {
    const norm = normalizeArgName(name);
    if (!byNormalized.has(norm)) byNormalized.set(norm, name); // first-write-wins on collision
  }

  const args: Record<string, unknown> = {};
  const dropped: string[] = [];
  const coercionSkipped: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    const target = exact.has(key) ? key : byNormalized.get(normalizeArgName(key));
    if (target === undefined) {
      dropped.push(key);
      continue;
    }
    const declared = declaredTypes?.[target];
    const coerced = coerceToDeclaredType(value, declared);
    args[target] = coerced;
    if (typeof coerced === 'string' && declared !== undefined && COERCIBLE_TYPES.has(declared)) {
      coercionSkipped.push(target);
    }
  }
  return { arguments: args, dropped, coercionSkipped };
}
