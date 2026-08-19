import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isRecord } from '../common/json-util';
import { validatedAppSlug } from '../providers/sdk-actions.registry';

/** An agent step resolves its slot under the MODEL's provider, not a node-type slug. */
const AGENT_TYPE = 'orchestr:agent';

/**
 * The apps a version will demand an environment SLOT for — the same set the runtime resolves, so a
 * promote refuses for the reason a run would (ADR 0014).
 *
 * The two rails ask differently and this must match both: an ACTION resolves a slot only when the
 * step names a connection, while an AGENT resolves its model provider's slot on every call, with or
 * without one.
 */
export function appsRequiringSlot(document: unknown): string[] {
  const nodes = isRecord(document) && Array.isArray(document.nodes) ? document.nodes : [];
  const apps = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const props = isRecord(node.parameters) ? node.parameters : {};
    if (node.node_type === AGENT_TYPE) {
      const provider = modelProvider(props);
      if (provider !== null) apps.add(provider);
      continue;
    }
    if (typeof props.connectionId !== 'string' || props.connectionId === '') continue;
    const app = typeof node.node_type === 'string' ? validatedAppSlug(node.node_type) : null;
    if (app !== null) apps.add(app);
  }
  return [...apps].sort();
}

function modelProvider(props: Record<string, unknown>): string | null {
  const model = isRecord(props.model) ? props.model : {};
  return typeof model.provider === 'string' && model.provider !== '' ? model.provider : null;
}

/**
 * Refuse to point an environment at a version it cannot run. Without this the promote succeeds and
 * the workflow reports green until a run happens to reach a connection-bearing step — three
 * schedules can sit "completed" for days because their filter never matched.
 */
export async function assertEnvSlotsCover(
  em: EntityManager,
  environmentId: string,
  environmentName: string,
  document: unknown,
): Promise<void> {
  const required = appsRequiringSlot(document);
  if (required.length === 0) return;
  const rows: Array<{ app: string }> = await em.query(
    `SELECT app FROM environment_connections WHERE environment_id = $1 AND app = ANY($2)`,
    [environmentId, required],
  );
  const filled = new Set(rows.map((row) => row.app));
  const missing = required.filter((app) => !filled.has(app));
  if (missing.length === 0) return;
  const one = missing.length === 1;
  throw new DomainError(
    `The ${environmentName} environment has no connection for ${missing.join(', ')} — assign ` +
      `${one ? 'it' : 'them'} to ${environmentName}'s ${one ? 'slot' : 'slots'} before promoting here`,
    428,
  );
}
