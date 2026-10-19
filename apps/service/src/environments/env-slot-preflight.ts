import { DomainError } from '../common/domain-error';
import { isRecord } from '../common/json-util';
import { isTriggerNode } from '../compiler/compile-ir';
import {
  connectionIdOf,
  planRunAs,
  type RunAsAccounts,
  type SlotRefusalReason,
  type StepRunAs,
} from '../connections/run-as-account';
import { validatedAppSlug } from '../providers/sdk-actions.registry';

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

// The apps of the app triggers naming an account that find no slot under `environment` — the slot their activation listens as.
async function triggerAppsUnslottedIn(
  document: unknown,
  environment: NamedEnvironment,
  accounts: Pick<RunAsAccounts, 'resolveSlotConnection'>,
): Promise<string[]> {
  const apps = triggerAppsNamingAccounts(document);
  const slots = await Promise.all(apps.map((app) => accounts.resolveSlotConnection(environment.id, app)));
  return apps.filter((_app, i) => slots[i] === null);
}

function triggerAppsNamingAccounts(document: unknown): string[] {
  const nodes = isRecord(document) && Array.isArray(document.nodes) ? document.nodes : [];
  const apps = nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.node_type !== 'string') return [];
    const metadata = isRecord(node.metadata) ? node.metadata : undefined;
    if (!isTriggerNode({ node_type: node.node_type, ...(metadata ? { metadata } : {}) })) return [];
    const app = validatedAppSlug(node.node_type);
    return app && connectionIdOf(node.parameters) !== null ? [app] : [];
  });
  return [...new Set(apps)].sort();
}

function triggerSlotsEmpty(environment: string, apps: string[]): DomainError {
  const one = apps.length === 1;
  return new DomainError(
    `The ${environment} environment has no connection for ${apps.join(', ')} — assign ${one ? 'it' : 'them'} to ` +
      `${environment}'s ${one ? 'slot' : 'slots'} before promoting here`,
    428,
  );
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
    'inactive_slot',
    (env, steps) =>
      `${env}'s ${accountsOf(steps, "account isn't", "accounts aren't")} active, so ${namesOf(steps)} can't run there`,
  ],
];

/** The 428 a check refuses with, naming the environment, the apps its slots can't run and the steps that need them. */
export function slotRefusalError(
  environment: NamedEnvironment,
  steps: StepRunAs[],
  fix: string,
): DomainError {
  const present = new Set(
    CLAUSES.map(([reason]) => reason).filter((reason) => withReason(steps, reason).length > 0),
  );
  const clauses = CLAUSES.filter(([reason]) => present.has(reason)).map(([reason, clause]) =>
    clause(environment.name, withReason(steps, reason)),
  );
  return new DomainError(`${clauses.join('; ')} — ${remedyFor(present, steps)}${fix}`, 428, {
    code: codeOf(present),
    environment: environment.name,
    apps: appsOf(steps),
    steps: steps.map((step) => ({
      node_id: step.node_id,
      node_name: step.node_name,
      app: step.app,
      reason: step.decision.kind === 'refused' ? step.decision.reason : null,
    })),
  });
}

function codeOf(present: ReadonlySet<SlotRefusalReason>): string {
  if (present.has('empty_slot')) return 'environment_slots_empty';
  return present.has('inactive_slot') ? 'environment_slots_inactive' : 'environment_slots_unfit';
}

// A slot is assigned or reassigned under Environments; an account that only isn't active is also mended by reconnecting it.
function remedyFor(present: ReadonlySet<SlotRefusalReason>, steps: StepRunAs[]): string {
  if (present.size === 1 && present.has('inactive_slot')) {
    return appsOf(steps).length > 1
      ? 'their owners reconnect them under Integrations, or an owner reassigns the slots under Integrations → Environments'
      : 'its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments';
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

/** Refuse to point an environment at a version it cannot run — an app trigger naming an account with no slot to listen as, or a step its slots can't run. */
export async function assertEnvSlotsCover(
  document: unknown,
  environment: NamedEnvironment,
  accounts: RunAsAccounts,
): Promise<void> {
  const unslotted = await triggerAppsUnslottedIn(document, environment, accounts);
  if (unslotted.length > 0) throw triggerSlotsEmpty(environment.name, unslotted);
  const refused = await stepsRefusedIn(document, environment, accounts);
  if (refused.length > 0) throw slotRefusalError(environment, refused, ' before promoting here');
}
