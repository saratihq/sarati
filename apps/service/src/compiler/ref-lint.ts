import { accountRefFields, accountRefText, isAccountRefField } from '../runtime/account-ref';
import { isTriggerNode } from './compile-ir';

/**
 * Save-time lint for native `{{ref}}` data references — a ref whose root doesn't exist, or points
 * at a step producing no output, would otherwise only fail at run time. It must mirror the
 * compiler/runtime scope rules exactly: `trigger` is seeded by the runtime, trigger nodes compile
 * away, IF/SWITCH produce no output, `$`-rooted refs are reserved, and loop body aliases are valid
 * scope names. Conservative by design — anything not clearly our syntax is skipped silently, since
 * a false warning trains users to ignore real ones.
 */

const EMBEDDED_REF = /\{\{\s*([^}]+?)\s*\}\}/g;

// A native ref root is a bare id-ish token; anything else is not our syntax and is skipped.
const REF_ROOT = /^[\w-]+$/;

// Control nodes that ROUTE: they write no output, so a `{{<id>.…}}` ref to one never resolves.
const NO_OUTPUT_TYPES = new Set(['orchestr:if', 'orchestr:switch']);

interface LintNode {
  id: string;
  name: string;
  node_type: string;
  parameters: Record<string, unknown>;
}

function lintableNodes(irDoc: Record<string, unknown>): LintNode[] {
  const nodes = irDoc.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(
    (n): n is LintNode =>
      n !== null &&
      typeof n === 'object' &&
      typeof (n as LintNode).id === 'string' &&
      typeof (n as LintNode).name === 'string' &&
      typeof (n as LintNode).node_type === 'string' &&
      typeof (n as LintNode).parameters === 'object' &&
      (n as LintNode).parameters !== null,
  );
}

/**
 * The scope aliases every loop node injects into its body — a ref to one is a valid alias, not an
 * unknown step. Reserved whenever ANY loop exists rather than body-scoped: the conservative direction.
 */
function collectLoopBindings(nodes: LintNode[]): Set<string> {
  const bindings = new Set<string>();
  for (const n of nodes) {
    if (n.node_type !== 'orchestr:loop') continue;
    const rawVar = n.parameters.item_var;
    const itemVar = typeof rawVar === 'string' && rawVar.trim() ? rawVar.trim() : 'item';
    bindings.add(itemVar);
    bindings.add(`${itemVar}Index`);
    bindings.add('loopRound');
    bindings.add('loopPrev');
  }
  return bindings;
}

function collectRefs(value: unknown, sink: (ref: string) => void): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(EMBEDDED_REF)) sink((match[1] ?? '').trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, sink);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, sink);
  }
}

/** Lint one IR document's data refs into human sentences; the commit still succeeds. A node `accountRefsWarnedElsewhere` matches gets no `{{$account…}}` warning here. */
export function lintDataRefs(
  irDoc: Record<string, unknown>,
  accountRefsWarnedElsewhere: (node: LintNode) => boolean = () => false,
): string[] {
  const nodes = lintableNodes(irDoc);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const loopBindings = collectLoopBindings(nodes);
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!accountRefsWarnedElsewhere(node)) warnings.push(...lintAccountRefs(node));
    // Trigger parameters configure the trigger; they are never resolved against the run scope.
    if (isTriggerNode(node)) continue;

    collectRefs(node.parameters, (ref) => {
      const root = ref.split('.')[0]?.trim() ?? '';
      if (!root || root.startsWith('$') || root === 'trigger') return;
      if (!REF_ROOT.test(root)) return;
      if (loopBindings.has(root)) return; // a loop body alias (item/…Index/loopRound/loopPrev)

      const dedupeKey = `${node.id}\0${root}`;
      if (seen.has(dedupeKey)) return;

      const target = byId.get(root);
      let warning: string | null = null;
      if (!target) {
        warning = `"${node.name}" references {{${ref}}}, but no step "${root}" exists — the run would fail there`;
      } else if (isTriggerNode(target)) {
        warning = `"${node.name}" references the trigger step by id — use {{trigger.…}} instead`;
      } else if (target.id === node.id) {
        warning = `"${node.name}" references its own output, which doesn't exist yet when it runs`;
      } else if (NO_OUTPUT_TYPES.has(target.node_type)) {
        warning = `"${node.name}" references "${target.name}", which produces no output — reference a step before it`;
      }
      if (warning) {
        seen.add(dedupeKey);
        warnings.push(warning);
      }
    });
  }
  return warnings;
}

/** `{{$account…}}` is filled only on an app step, and only with a field an account has; which account is its run's to decide. */
function lintAccountRefs(node: LintNode): string[] {
  const fields = [...new Set(accountRefFields(node.parameters))];
  if (fields.length === 0) return [];
  if (isTriggerNode(node) || node.node_type.startsWith('orchestr:')) {
    const ref = accountRefText(fields[0] ?? '');
    return [`"${node.name}" uses ${ref}, but only an app step that runs as a connected account can`];
  }
  return fields
    .filter((field) => !isAccountRefField(field))
    .map(
      (field) =>
        `"${node.name}" uses ${accountRefText(field)}, but an account has only an email, handle, id and name`,
    );
}
