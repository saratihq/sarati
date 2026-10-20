import { DomainError } from '../common/domain-error';
import { isRecord } from '../common/json-util';
import {
  planRunAs,
  type RunAsAccounts,
  type SlotRefusalReason,
  type StepRunAs,
} from '../connections/run-as-account';
import { decideTriggerSlots, type TriggerNode } from '../triggers/canvas/trigger-kind';

/** An environment a check predicts a run under. */
export interface NamedEnvironment {
  id: string;
  name: string;
}

/** The steps of `document` a run under `environment` would refuse — the run-as rule's own answer, dry. */
export async function stepsRefusedIn(
  document: unknown,
  environment: NamedEnvironment,
  accounts: RunAsAccounts,
): Promise<StepRunAs[]> {
  // An environment run takes every account from its slots, so no runner is consulted.
  const scope = { externalUserId: '', environmentId: environment.id, environment: environment.name };
  const plan = await planRunAs(document, scope, accounts);
  return plan.filter((step) => step.decision.kind === 'refused');
}

// The app triggers whose slot under `environment`, the account their activation would listen as, can't serve them.
async function triggersRefusedIn(
  document: unknown,
  environment: NamedEnvironment,
  accounts: Pick<RunAsAccounts, 'resolveSlotConnection'>,
): Promise<StepRunAs[]> {
  const decided = await decideTriggerSlots(triggerNodesOf(document), environment.name, (app) =>
    accounts.resolveSlotConnection(environment.id, app),
  );
  return decided
    .filter((trigger) => trigger.decision.kind === 'refused')
    .map((trigger) => ({
      node_id: trigger.nodeId,
      node_name: trigger.name,
      app: trigger.slot.app,
      managed_only: trigger.slot.managedOnly,
      decision: trigger.decision,
    }));
}

function triggerNodesOf(document: unknown): TriggerNode[] {
  const nodes = isRecord(document) && Array.isArray(document.nodes) ? document.nodes : [];
  return nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.node_type !== 'string') return [];
    const metadata = isRecord(node.metadata) ? node.metadata : undefined;
    const name = typeof node.name === 'string' ? node.name : undefined;
    return [
      {
        id: node.id,
        node_type: node.node_type,
        ...(name ? { name } : {}),
        ...(metadata ? { metadata } : {}),
      },
    ];
  });
}

// A clause may name a model provider beside an app, so every clause names each by its slug.
type Clause = (environment: string, steps: StepRunAs[]) => string;

const CLAUSES: ReadonlyArray<[SlotRefusalReason, Clause]> = [
  [
    'empty_slot',
    (env, steps) =>
      `${env} has no ${listed(appsOf(steps), 'or')} account assigned, so ${namesOf(steps)} can't run there`,
  ],
  [
    'wrong_app_slot',
    (env, steps) =>
      `${env}'s ${accountsOf(steps, 'account is', 'accounts are')} for another app, so ${namesOf(steps)} can't run there`,
  ],
  [
    'needs_managed_slot',
    (env, steps) =>
      `${env}'s ${accountsOf(steps, 'account uses its', 'accounts use their')} own credentials, and ${namesOf(steps)} ${
        steps.length === 1 ? 'runs' : 'run'
      } only on a one-click (managed) one, so ${steps.length === 1 ? 'it' : 'they'} can't run there`,
  ],
  [
    'needs_own_credentials_slot',
    (env, steps) =>
      `${env}'s ${accountsOf(steps, 'account is', 'accounts are')} one-click (managed), and ${namesOf(steps)} ${
        steps.length === 1 ? 'runs only on one that uses its' : 'run only on ones that use their'
      } own credentials, so ${steps.length === 1 ? 'it' : 'they'} can't run there`,
  ],
  [
    'inactive_slot',
    (env, steps) =>
      `${env}'s ${accountsOf(steps, "account isn't", "accounts aren't")} active, so ${namesOf(steps)} can't run there`,
  ],
];

/** The 428 a check refuses with, naming the environment, the apps its slots can't run and the triggers and steps that need them. */
export function slotRefusalError(
  environment: NamedEnvironment,
  steps: StepRunAs[],
  fix: string,
  triggers: StepRunAs[] = [],
): DomainError {
  const refused = [...triggers, ...steps];
  const present = new Set(
    CLAUSES.map(([reason]) => reason).filter((reason) => withReason(refused, reason).length > 0),
  );
  const clauses = CLAUSES.filter(([reason]) => present.has(reason)).map(([reason, clause]) =>
    clause(environment.name, withReason(refused, reason)),
  );
  return new DomainError(`${clauses.join('; ')} — ${remedyFor(present, refused)}${fix}`, 428, {
    code: codeOf(present),
    environment: environment.name,
    apps: appsOf(refused),
    steps: steps.map(refusedNode),
    ...(triggers.length > 0 ? { triggers: triggers.map(refusedNode) } : {}),
  });
}

function refusedNode(node: StepRunAs): Record<string, unknown> {
  return {
    node_id: node.node_id,
    node_name: node.node_name,
    app: node.app,
    reason: node.decision.kind === 'refused' ? node.decision.reason : null,
  };
}

function codeOf(present: ReadonlySet<SlotRefusalReason>): string {
  if (present.has('empty_slot')) return 'environment_slots_empty';
  return present.has('inactive_slot') ? 'environment_slots_inactive' : 'environment_slots_unfit';
}

// A slot is assigned or reassigned under Environments; an account that only isn't active also comes back once a test finds it working.
function remedyFor(present: ReadonlySet<SlotRefusalReason>, steps: StepRunAs[]): string {
  if (present.size === 1 && present.has('inactive_slot')) {
    return appsOf(steps).length > 1
      ? 'their owners test them under Integrations once they work again, or an owner reassigns the slots under Integrations → Environments'
      : 'its owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments';
  }
  const empty = present.has('empty_slot');
  const held = [...present].some((reason) => reason !== 'empty_slot');
  const actions = [...(empty ? ['assign'] : []), ...(held ? ['reassign'] : [])];
  const object = appsOf(steps).length > 1 ? 'them' : actions.length === 1 && empty ? 'one' : 'it';
  return `${actions.join(' or ')} ${object} under Integrations → Environments`;
}

function accountsOf(steps: StepRunAs[], one: string, many: string): string {
  const apps = appsOf(steps);
  return `${listed(apps, 'and')} ${apps.length === 1 ? one : many}`;
}

function listed(items: string[], conjunction: 'and' | 'or'): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

function withReason(steps: StepRunAs[], reason: SlotRefusalReason): StepRunAs[] {
  return steps.filter((step) => step.decision.kind === 'refused' && step.decision.reason === reason);
}

function appsOf(steps: StepRunAs[]): string[] {
  return [...new Set(steps.map((step) => step.app))].sort();
}

function namesOf(steps: StepRunAs[]): string {
  return listed(
    steps.map((step) => `"${step.node_name}"`),
    'and',
  );
}

/** Refuse to point an environment at a version it cannot run — an app trigger its slot can't serve, or a step its slots can't run. */
export async function assertEnvSlotsCover(
  document: unknown,
  environment: NamedEnvironment,
  accounts: RunAsAccounts,
): Promise<void> {
  const triggers = await triggersRefusedIn(document, environment, accounts);
  const steps = await stepsRefusedIn(document, environment, accounts);
  if (triggers.length + steps.length > 0) {
    throw slotRefusalError(environment, steps, ' before promoting here', triggers);
  }
}
