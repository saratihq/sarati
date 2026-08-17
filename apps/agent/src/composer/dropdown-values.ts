/**
 * A dropdown's option VALUE is what a step runs on; its label is what a person says. The composer
 * hears labels ("#social", "Public channels") and would otherwise write them straight into the
 * document, leaving the editor's picker showing two identical-looking rows. Everything the agent
 * writes goes through here first, so a label is resolved to its value before it is stored.
 */

/** One option a static or live dropdown offers. */
export interface DropdownOption {
  label: string;
  value: unknown;
}

/** The outcome of resolving one node's parameters: what to write, and what to tell the agent. */
export interface DropdownResolution {
  parameters: Record<string, unknown>;
  /** One line per value rewritten or left unmatched — surfaced so the agent can self-correct. */
  notes: string[];
}

/** Prop kinds whose value must come from an option set. */
const OPTION_KINDS = new Set(['DROPDOWN', 'STATIC_DROPDOWN']);

/** Options a caller could not load (no account, no such prop) — leave the value untouched. */
export type OptionLoader = (prop: string) => Promise<DropdownOption[] | null>;

/** `#social` and `social` are the same channel to a person; match them the same way. */
function normalize(text: string): string {
  return text.trim().replace(/^[#@]/, '').toLowerCase();
}

function optionsInSchema(def: Record<string, unknown>): DropdownOption[] | null {
  if (!Array.isArray(def.options)) return null;
  return def.options
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
    .map((o) => ({ label: typeof o.label === 'string' ? o.label : String(o.value), value: o.value }));
}

function matchByLabel(options: readonly DropdownOption[], written: string): DropdownOption | undefined {
  return (
    options.find((o) => o.label === written) ??
    options.find((o) => normalize(o.label) === normalize(written))
  );
}

/** A short, bounded sample of what the picker does offer — enough for the agent to pick again. */
function sampleLabels(options: readonly DropdownOption[]): string {
  return options
    .slice(0, 8)
    .map((o) => o.label)
    .join(', ');
}

/**
 * Rewrite every option-backed parameter the agent wrote as a LABEL into that option's value.
 * Fail-open by design: an unloadable option set, a `{{ref}}`, or a value that matches nothing is
 * left exactly as written — this resolves what it can prove, and reports the rest.
 */
export async function resolveDropdownParams(
  schema: Record<string, unknown>,
  parameters: Record<string, unknown>,
  loadOptions: OptionLoader,
): Promise<DropdownResolution> {
  const resolved = { ...parameters };
  const notes: string[] = [];

  for (const [key, value] of Object.entries(parameters)) {
    const def = schema[key];
    if (!def || typeof def !== 'object') continue;
    const kind = (def as Record<string, unknown>).type;
    if (typeof kind !== 'string' || !OPTION_KINDS.has(kind)) continue;
    // A reference resolves at run time; there is nothing to match it against now.
    if (typeof value !== 'string' || value.includes('{{')) continue;

    const options =
      kind === 'STATIC_DROPDOWN'
        ? optionsInSchema(def as Record<string, unknown>)
        : await loadOptions(key);
    if (!options || options.length === 0) continue;
    if (options.some((o) => String(o.value) === value)) continue;

    const match = matchByLabel(options, value);
    if (match) {
      resolved[key] = match.value;
      notes.push(`${key}: "${value}" is the label of "${String(match.value)}" — stored the value.`);
    } else {
      notes.push(`${key}: "${value}" is not one of the options (${sampleLabels(options)}).`);
    }
  }

  return { parameters: resolved, notes };
}
