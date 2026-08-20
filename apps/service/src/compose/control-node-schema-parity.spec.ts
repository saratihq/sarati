import { CONTROL_NODE_SCHEMAS } from '../generation/control-node-types';
import type { VectorStore } from '../generation/vector-store';
import type { TriggerCatalogService } from '../triggers/trigger-catalog.service';

import { ComposeCatalogService } from './compose-catalog.service';

/** Any scope will do here — the tests are about behaviour, not about whose key it is. */
const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;

/**
 * Drift guard: the palette (`CONTROL_NODE_SCHEMAS`, served verbatim) and the composer
 * (`ComposeCatalogService.byType`) must expose IDENTICAL control-node schema data. The parameter
 * SCHEMA is single-sourced; only the node `description` is a per-consumer projection, so it is
 * intentionally excluded from the comparison.
 */

// The 7 control constructs both surfaces share (the composer additionally emits a
// presentational `orchestr:trigger` head node the palette has no catalog row for).
const SHARED_CONTROL_TYPES = [
  'orchestr:if',
  'orchestr:switch',
  'orchestr:wait_for_duration',
  'orchestr:wait_for_event',
  'orchestr:code',
  'orchestr:loop',
  'orchestr:agent',
  'orchestr:call_workflow',
] as const;

/** The schema-bearing fields — everything except the per-consumer node `description`. */
function schemaOf(entry: {
  name?: unknown;
  type?: unknown;
  category?: unknown;
  auth?: unknown;
  parameters?: unknown;
}): Record<string, unknown> {
  return {
    name: entry.name,
    type: entry.type,
    category: entry.category,
    auth: entry.auth,
    parameters: entry.parameters,
  };
}

// byType resolves control types from CONTROL_TYPES before touching either catalog.
const stubVectorStore = {
  entries: () => [],
  search: () => [],
} as unknown as VectorStore;
const stubTriggerCatalog = { list: () => Promise.resolve([]) } as unknown as TriggerCatalogService;

describe('control-node schema parity — palette (node-types controller) vs composer (compose-catalog)', () => {
  const catalog = new ComposeCatalogService(stubVectorStore, stubTriggerCatalog);

  it('the palette serves exactly the 8 shared control constructs', () => {
    expect([...CONTROL_NODE_SCHEMAS].map((s) => s.type).sort()).toEqual([...SHARED_CONTROL_TYPES].sort());
  });

  it.each(SHARED_CONTROL_TYPES)('%s exposes identical schema data on both surfaces', async (type) => {
    const palette = CONTROL_NODE_SCHEMAS.find((s) => s.type === type);
    const composer = await catalog.byType(SCOPE, type);
    expect(palette).toBeDefined();
    expect(composer).not.toBeNull();
    // Deep-equal the parameter schema (and name/type/category/auth) — the node
    // description legitimately differs per audience and is excluded.
    expect(schemaOf(composer ?? {})).toEqual(schemaOf(palette ?? {}));
  });

  it('the agent carries an OPTIONAL connectionId on both surfaces (env-slot fallback)', async () => {
    const agent = await catalog.byType(SCOPE, 'orchestr:agent');
    const params = agent?.parameters as Record<string, { type: string; required: boolean }>;
    expect(params.connectionId).toBeDefined();
    expect(params.connectionId?.type).toBe('string');
    expect(params.connectionId?.required).toBe(false);
  });

  it("the IF op seeds a default of 'eq' on both surfaces", async () => {
    const ifNode = await catalog.byType(SCOPE, 'orchestr:if');
    const params = ifNode?.parameters as Record<string, { defaultValue?: unknown }>;
    expect(params.op?.defaultValue).toBe('eq');
  });

  it('the composer-only trigger head exists on the composer surface but not the palette', async () => {
    expect(await catalog.byType(SCOPE, 'orchestr:trigger')).not.toBeNull();
    expect(CONTROL_NODE_SCHEMAS.find((s) => s.type === 'orchestr:trigger')).toBeUndefined();
  });
});
