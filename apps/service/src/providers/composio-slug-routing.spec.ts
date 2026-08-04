import { toComposioSlug } from '../connections/managed-connections.service';
import { matchTool, type ComposioToolShape } from '../connections/composio-tool-mapping';
import { composioToolFor, loadComposioCatalog, type CatalogEntry } from './sdk-actions.registry';

/**
 * Regression: the Composio rail must route by the EXACT recorded slug, never by re-deriving it with the fuzzy
 * matcher. Reconstructs the matcher's candidate set from the catalog itself, so no live Composio call is needed.
 */
const paramKeys = (e: CatalogEntry): string[] => {
  const p = e.parameters;
  return p && typeof p === 'object' ? Object.keys(p) : [];
};
const paramTypes = (e: CatalogEntry): Record<string, string> => {
  const p = e.parameters;
  if (!p || typeof p !== 'object') return {};
  const types: Record<string, string> = {};
  for (const [name, schema] of Object.entries(p as Record<string, unknown>)) {
    const t = schema && typeof schema === 'object' ? (schema as { type?: unknown }).type : undefined;
    if (typeof t === 'string') types[name] = t;
  }
  return types;
};
const paramRequired = (e: CatalogEntry): string[] => {
  const p = e.parameters;
  if (!p || typeof p !== 'object') return [];
  const required: string[] = [];
  for (const [name, schema] of Object.entries(p as Record<string, unknown>)) {
    const r = schema && typeof schema === 'object' ? (schema as { required?: unknown }).required : undefined;
    if (r === true) required.push(name);
  }
  return required;
};
const actionOf = (e: CatalogEntry): string => String(e.type).slice(String(e.category).length + 1);

describe('Composio slug routing (B2)', () => {
  const catalog = loadComposioCatalog();

  it('the catalog is present and every row carries its exact source slug', () => {
    expect(catalog.length).toBeGreaterThan(1000);
    const missing = catalog.filter((e) => typeof e.composioSlug !== 'string' || !e.composioSlug);
    expect(missing).toHaveLength(0);
  });

  it('composioToolFor returns the EXACT recorded slug + the tool arg names/types/required for every row', () => {
    for (const e of catalog) {
      const resolved = composioToolFor(String(e.type));
      expect(resolved).toEqual({
        slug: e.composioSlug,
        inputProperties: paramKeys(e),
        inputTypes: paramTypes(e),
        required: paramRequired(e),
      });
    }
  });

  it('an action not in the catalog resolves to undefined (falls back to the matcher)', () => {
    expect(composioToolFor('slack.this_action_does_not_exist')).toBeUndefined();
    expect(composioToolFor('not-an-app')).toBeUndefined();
  });

  it('the exact path never misroutes, where the fuzzy matcher demonstrably did', () => {
    // Reconstruct the matcher's per-toolkit candidate set from the catalog: each
    // row's recorded slug + name + arg names is one candidate tool.
    const byToolkit = new Map<string, ComposioToolShape[]>();
    for (const e of catalog) {
      const toolkit = toComposioSlug(String(e.category));
      const list = byToolkit.get(toolkit) ?? byToolkit.set(toolkit, []).get(toolkit)!;
      list.push({ slug: String(e.composioSlug), name: String(e.name), inputProperties: paramKeys(e) });
    }

    let fuzzyMisroutes = 0;
    let exactMisroutes = 0;
    for (const e of catalog) {
      const toolkit = toComposioSlug(String(e.category));
      const candidates = byToolkit.get(toolkit)!;
      // Fuzzy: derive the slug from the action name over the candidate set.
      const fuzzy = matchTool(actionOf(e), toolkit, candidates);
      if (!fuzzy || fuzzy.slug !== e.composioSlug) fuzzyMisroutes += 1;
      // Exact: the recorded slug is authoritative.
      if (composioToolFor(String(e.type))?.slug !== e.composioSlug) exactMisroutes += 1;
    }

    console.log(
      `[B2] reconstructed fuzzy misroutes: ${fuzzyMisroutes}/${catalog.length}; exact: ${exactMisroutes}`,
    );
    // The fuzzy path really does pick a different (or no) tool for genuine catalog actions.
    expect(fuzzyMisroutes).toBeGreaterThan(0);
    // Routing by the recorded slug is correct for ALL rows.
    expect(exactMisroutes).toBe(0);
  });
});
