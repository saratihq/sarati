import { DomainError } from '../common/domain-error';
import { isRecord } from '../common/json-util';
import { isTriggerNode } from '../compiler/compile-ir';
import { agentModelProvider } from '../compiler/compile-ir-dag';
import {
  actionNeedsAccount,
  actionNeedsManagedAccount,
  validatedAppSlug,
} from '../providers/sdk-actions.registry';
import { AGENT_PROVIDER_LABEL, type AgentProvider } from '../runtime/agent';

/** Where a run is: an `environmentId` (or the legacy NAME + `orgId`) is an environment run; none is a Default run. */
export interface RunAsWhere {
  environment?: string | null;
  environmentId?: string | null;
  orgId?: string | null;
}

/** Who runs, and where: a Default run runs as `externalUserId`. */
export interface RunAsScope extends RunAsWhere {
  externalUserId: string;
}

/** A step as the rule sees it. */
export interface RunAsStep {
  /** The name a person knows the step by. */
  name: string;
  /** The app whose account it runs as. */
  app: string;
  /** How a message writes the app; the slug when absent. */
  label?: string;
  /** The account chosen on the step, if any. */
  connectionId: string | null;
  /** Where an account for it is connected, when "connect one" alone wouldn't say. */
  connectHint?: string;
  /** It runs only on a one-click (managed) account (see {@link actionNeedsManagedAccount}). */
  managedOnly?: boolean;
}

/** A step or trigger as the slot rule sees it. */
export interface SlotStep extends RunAsStep {
  /** It runs only on an account that uses its own credentials: a trigger on the SDK's direct rail. */
  ownCredentialsOnly?: boolean;
}

/** A pool connection and the user who owns it — the step runs AS that user. */
export interface OwnedConnection {
  id: string;
  ownerUserId: string;
}

/** One of the runner's own connections: the app it is for, its status, and whether it is one-click (managed). */
export interface OwnAccount {
  provider: string;
  status: string;
  managed: boolean;
}

/** An environment slot's account and its owner — it runs only while it serves the step and is `active`. */
export interface SlotAccount extends OwnedConnection, OwnAccount {}

/** One of the runner's active personal accounts: its id, the app it is for, and whether it is one-click (managed). */
export interface ServingAccount {
  id: string;
  provider: string;
  managed: boolean;
}

/** The connection-store slice the rule reads — structural, so this module imports no service. */
export interface RunAsAccounts {
  resolveSlotConnection(environmentId: string, app: string): Promise<SlotAccount | null>;
  resolveClusterConnection(orgId: string, environment: string, app: string): Promise<SlotAccount | null>;
  environmentNameOf(environmentId: string): Promise<string | null>;
  /** Those of `connectionIds` that are `userId`'s connections, by id, in one read; an id that isn't theirs is absent. */
  ownConnections(userId: string, connectionIds: readonly string[]): Promise<ReadonlyMap<string, OwnAccount>>;
  /** The user's active personal accounts that serve any of `apps` (see {@link providersServing}), newest first, in one read. */
  accountsServing(userId: string, apps: readonly string[]): Promise<ServingAccount[]>;
}

/** Why a step has no account to run as: the `_slot` ones under an environment, the rest on Default. */
export type RunAsRefusalReason =
  | 'empty_slot'
  | 'wrong_app_slot'
  | 'needs_managed_slot'
  | 'needs_own_credentials_slot'
  | 'inactive_slot'
  | 'inactive'
  | 'needs_managed'
  | 'none'
  | 'several'
  | 'stale'
  | 'wrong_app';

/** The refusals of an environment run — its slot, never the runner, decides. */
export type SlotRefusalReason = Extract<
  RunAsRefusalReason,
  'empty_slot' | 'wrong_app_slot' | 'needs_managed_slot' | 'needs_own_credentials_slot' | 'inactive_slot'
>;

/** The account a step runs as, or why it can't run. */
export type RunAsDecision =
  | { kind: 'account'; connectionId: string; ownerUserId: string; via: 'slot' | 'chosen' | 'only' }
  | {
      kind: 'refused';
      reason: RunAsRefusalReason;
      status: 422 | 428;
      message: string;
    };

/** Why a step can't run. */
export type RunAsRefusal = Extract<RunAsDecision, { kind: 'refused' }>;

/** THE app-matching rule: the providers whose accounts serve `app` — itself and each family it belongs to (`zoho` serves `zoho-crm`). */
export function providersServing(app: string): string[] {
  const providers = [app];
  for (let dash = app.indexOf('-'); dash > 0; dash = app.indexOf('-', dash + 1)) {
    providers.push(app.slice(0, dash));
  }
  return providers;
}

/** Extract a checkpoint-safe `{ connectionId }` reference — the account chosen on a step — or null. */
export function connectionIdOf(auth: unknown): string | null {
  const id = isRecord(auth) ? auth.connectionId : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** A credential handed to a step itself (a raw plan's `auth`), not an account: a rail runs on it as handed, outside the rule, never swapped for one. */
export function isInlineCredential(auth: unknown): boolean {
  if (typeof auth === 'string') return auth !== '';
  return isRecord(auth) && !('connectionId' in auth) && Object.keys(auth).length > 0;
}

/** THE decision of which account a step runs as (constitution #18), asked by every in-process rail and every check that predicts a run. */
export async function decideRunAs(
  step: RunAsStep,
  scope: RunAsScope,
  accounts: RunAsAccounts,
): Promise<RunAsDecision> {
  const nameOf = async () => (await environmentNamed(scope, accounts)) ?? '';
  if (scope.environmentId) {
    return decideBySlot(step, await accounts.resolveSlotConnection(scope.environmentId, step.app), nameOf);
  }
  if (scope.environment && scope.orgId) {
    const slot = await accounts.resolveClusterConnection(scope.orgId, scope.environment, step.app);
    return decideBySlot(step, slot, nameOf);
  }
  return forRunner(step, scope.externalUserId, accounts);
}

function runsAsRunner(scope: RunAsWhere): boolean {
  return !scope.environmentId && !(scope.environment && scope.orgId);
}

// The environment a run is under, by its current name (a run records the one it had at dispatch); null on Default.
async function environmentNamed(
  where: RunAsWhere,
  accounts: Pick<RunAsAccounts, 'environmentNameOf'>,
): Promise<string | null> {
  if (where.environmentId) {
    return (await accounts.environmentNameOf(where.environmentId)) ?? where.environment ?? 'This environment';
  }
  return where.environment && where.orgId ? where.environment : null;
}

/** {@link decideRunAs}, throwing the refusal a run fails with. */
export async function resolveRunAs(
  step: RunAsStep,
  scope: RunAsScope,
  accounts: RunAsAccounts,
): Promise<OwnedConnection> {
  const decision = await decideRunAs(step, scope, accounts);
  if (decision.kind === 'refused') throw refusalError(decision);
  return { id: decision.connectionId, ownerUserId: decision.ownerUserId };
}

function refusalError(refusal: RunAsRefusal): DomainError {
  return new DomainError(refusal.message, refusal.status, { reason: refusal.reason });
}

/** An action step as a message names it: its own name, else its action. */
export function actionStep(input: { actionId: string; stepName?: string }): Pick<RunAsStep, 'name' | 'app'> {
  return { name: input.stepName ?? input.actionId, app: validatedAppSlug(input.actionId) ?? input.actionId };
}

/** An AI Agent step's model call as the rule sees it: its provider's account, which is your own credentials. */
export function agentModelStep(
  name: string,
  provider: AgentProvider,
  connectionId: string | null,
): RunAsStep {
  const label = AGENT_PROVIDER_LABEL[provider] ?? provider;
  // The platform Anthropic key is the composer's and is deliberately not consulted, so a Claude refusal says so.
  const composer =
    provider === 'claude'
      ? '. The Anthropic key in Settings → Platform keys powers the AI composer only, not agent steps'
      : '';
  return {
    name,
    app: provider,
    label,
    connectionId,
    connectHint: ` under Integrations → "Use your own credentials" → ${label}${composer}`,
  };
}

type NamedStep = Pick<RunAsStep, 'name' | 'app' | 'label'>;

/** What a step with no account to run as fails with, on Default or on a rail handed none. */
export function noAccountMessage(step: Pick<RunAsStep, 'name' | 'app' | 'label' | 'connectHint'>): string {
  return `Step "${step.name}" has no ${step.label ?? step.app} account to run as — connect one${step.connectHint ?? ''}`;
}

function staleAccountMessage(step: NamedStep): string {
  const label = step.label ?? step.app;
  return `Step "${step.name}" runs as a ${label} account that no longer exists or isn't yours — pick one of your ${label} accounts on the step`;
}

function inactiveAccountMessage(step: NamedStep): string {
  const label = step.label ?? step.app;
  return `Step "${step.name}" runs as a ${label} account that isn't active — pick another of your ${label} accounts on the step`;
}

function emptySlotMessage(environment: string, step: NamedStep): string {
  const label = step.label ?? step.app;
  return `${environment} has no ${label} account assigned, so "${step.name}" can't run there — an owner assigns one under Integrations → Environments`;
}

/** What brings a slot's inactive account back, after "its owner": Reconnect connects a new account, which a slot holds only once assigned. */
export const REVIVES_SLOT =
  'tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments';

function inactiveSlotMessage(environment: string, step: NamedStep): string {
  const label = step.label ?? step.app;
  return `${environment}'s ${label} account isn't active, so "${step.name}" can't run there — its owner ${REVIVES_SLOT}`;
}

/** What a trigger held while its slot's account isn't active says: what it still does, and what releases it (#11). */
export function heldTriggerMessage(environment: string, trigger: NamedStep, firesWhileHeld: boolean): string {
  const label = trigger.label ?? trigger.app;
  const meanwhile = firesWhileHeld
    ? `what ${label} sends still starts runs, and nothing is changed at ${label} until the account is active again`
    : "it isn't polled, and picks up from where it stopped once the account is active again";
  return `${environment}'s ${label} account isn't active, so "${trigger.name}" is held: ${meanwhile} — the account's owner ${REVIVES_SLOT}`;
}

/** What a connected credential lacks for its step's sign-in, and how it is fixed. */
export interface CredentialGap {
  lacks: string;
  fix: string;
}

/** How an account decided for a step failed its rail: gone, not active, or its credential lacks what the step's sign-in needs. */
export type LostAccount = 'removed' | 'inactive' | CredentialGap;

/** What a rail reports when the account decided for a step fails it by the time it asks — as the decision words it where the run is. */
export async function lostAccountMessage(
  lost: LostAccount,
  step: NamedStep,
  where: RunAsWhere,
  accounts: Pick<RunAsAccounts, 'environmentNameOf'>,
): Promise<string> {
  const environment = await environmentNamed(where, accounts);
  const label = step.label ?? step.app;
  if (environment === null) {
    if (typeof lost === 'object') {
      return `Step "${step.name}" runs as a ${label} account that ${lost.lacks} — ${lost.fix}, or pick another of your ${label} accounts on the step`;
    }
    return lost === 'removed' ? staleAccountMessage(step) : inactiveAccountMessage(step);
  }
  if (typeof lost === 'object') {
    return `${environment}'s ${label} account ${lost.lacks}, so "${step.name}" can't run there — ${lost.fix}, or an owner reassigns it under Integrations → Environments`;
  }
  return lost === 'removed' ? emptySlotMessage(environment, step) : inactiveSlotMessage(environment, step);
}

/** The slot half of {@link decideRunAs}: whether an environment's account for the step's app, already read, serves it — the rule an app trigger listens by too (#11). */
export async function decideBySlot(
  step: SlotStep,
  slot: SlotAccount | null,
  nameOf: () => Promise<string>,
): Promise<RunAsDecision> {
  const unfit = slot ? slotUnfitFor(step, slot) : null;
  if (slot && unfit === null) {
    return { kind: 'account', connectionId: slot.id, ownerUserId: slot.ownerUserId, via: 'slot' };
  }
  return refuseSlot(await nameOf(), step, slot, unfit);
}

type Unfit = 'wrong_app' | 'needs_managed' | 'needs_own_credentials' | 'inactive';

function slotUnfitFor(step: SlotStep, slot: SlotAccount): Unfit | null {
  const unfit = unfitFor(step, slot);
  if (unfit !== null) return unfit;
  if (step.ownCredentialsOnly && slot.managed) return 'needs_own_credentials';
  return slot.status === 'active' ? null : 'inactive';
}

function refuseSlot(
  environment: string,
  step: NamedStep,
  slot: Pick<SlotAccount, 'provider'> | null,
  unfit: Unfit | null,
): RunAsRefusal {
  const label = step.label ?? step.app;
  if (!slot) return slotRefused('empty_slot', emptySlotMessage(environment, step));
  if (unfit === 'wrong_app') {
    return slotRefused(
      'wrong_app_slot',
      `${environment}'s ${label} account is for ${slot.provider}, so "${step.name}" can't run there — an owner assigns ${anAccount(label)} under Integrations → Environments`,
    );
  }
  if (unfit === 'needs_managed') {
    return slotRefused(
      'needs_managed_slot',
      `${environment}'s ${label} account uses its own credentials, and "${step.name}" runs only on a one-click (managed) one, so it can't run there — an owner assigns a one-click ${label} account under Integrations → Environments`,
    );
  }
  if (unfit === 'needs_own_credentials') {
    return slotRefused(
      'needs_own_credentials_slot',
      `${environment}'s ${label} account is one-click (managed), and "${step.name}" runs only on one that uses its own credentials, so it can't run there — an owner assigns ${anAccount(label)} that uses its own credentials under Integrations → Environments`,
    );
  }
  return slotRefused('inactive_slot', inactiveSlotMessage(environment, step));
}

function anAccount(label: string): string {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} account`;
}

function unfitFor(
  step: Pick<RunAsStep, 'app' | 'managedOnly'>,
  account: Pick<OwnAccount, 'provider' | 'managed'>,
): Extract<Unfit, 'wrong_app' | 'needs_managed'> | null {
  if (!providersServing(step.app).includes(account.provider)) return 'wrong_app';
  return step.managedOnly && !account.managed ? 'needs_managed' : null;
}

function slotRefused(reason: SlotRefusalReason, message: string): RunAsRefusal {
  return { kind: 'refused', reason, status: 428, message };
}

async function forRunner(step: RunAsStep, runner: string, accounts: RunAsAccounts): Promise<RunAsDecision> {
  const label = step.label ?? step.app;
  if (step.connectionId) {
    const own = (await accounts.ownConnections(runner, [step.connectionId])).get(step.connectionId) ?? null;
    if (own === null) return refused('stale', staleAccountMessage(step));
    const unfit = unfitFor(step, own);
    if (unfit === 'wrong_app') {
      return refused(
        'wrong_app',
        `Step "${step.name}" runs as an account for ${own.provider}, not ${label} — pick one of your ${label} accounts on the step`,
      );
    }
    if (unfit === 'needs_managed') {
      return refused(
        'needs_managed',
        `Step "${step.name}" runs as an account that uses its own credentials, and it runs only on a one-click (managed) ${label} account — pick one on the step, or connect one under Integrations`,
      );
    }
    if (own.status !== 'active') return refused('inactive', inactiveAccountMessage(step));
    return { kind: 'account', connectionId: step.connectionId, ownerUserId: runner, via: 'chosen' };
  }
  const managedOnly = step.managedOnly === true;
  const candidates = fitting(await accounts.accountsServing(runner, [step.app]), step);
  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return { kind: 'account', connectionId: only, ownerUserId: runner, via: 'only' };
  }
  if (candidates.length === 0) {
    return refused(
      'none',
      managedOnly
        ? `Step "${step.name}" runs only on a one-click (managed) ${label} account, and you have none — connect one under Integrations`
        : noAccountMessage(step),
    );
  }
  const kind = managedOnly ? 'one-click ' : '';
  return refused(
    'several',
    `Step "${step.name}" has no ${label} account chosen and you have ${candidates.length} active ${kind}${label} accounts — pick one on the step`,
  );
}

function refused(reason: Exclude<RunAsRefusalReason, SlotRefusalReason>, message: string): RunAsRefusal {
  return { kind: 'refused', reason, status: 422, message };
}

function fitting(serving: readonly ServingAccount[], step: Pick<RunAsStep, 'app' | 'managedOnly'>): string[] {
  return serving.filter((account) => unfitFor(step, account) === null).map((account) => account.id);
}

/** A step of a document that runs as an account. */
export interface DocumentStep extends RunAsStep {
  nodeId: string;
}

/** Every step of a document that runs as an account: its catalog actions needing one and its AI Agents' models (a trigger's is its activation's). */
export function stepsRunningAsAccounts(document: unknown): DocumentStep[] {
  const nodes = isRecord(document) && Array.isArray(document.nodes) ? document.nodes : [];
  return nodes.flatMap((node): DocumentStep[] => {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.node_type !== 'string') return [];
    const metadata = isRecord(node.metadata) ? node.metadata : undefined;
    if (isTriggerNode({ node_type: node.node_type, ...(metadata ? { metadata } : {}) })) return [];
    const name = typeof node.name === 'string' && node.name !== '' ? node.name : node.id;
    const connectionId = connectionIdOf(node.parameters);
    const provider = agentModelProvider({ node_type: node.node_type, parameters: node.parameters });
    if (provider) return [{ nodeId: node.id, ...agentModelStep(name, provider, connectionId) }];
    const app = validatedAppSlug(node.node_type);
    if (!app || !actionNeedsAccount(node.node_type)) return [];
    const managedOnly = actionNeedsManagedAccount(node.node_type);
    return [{ nodeId: node.id, name, app, connectionId, ...(managedOnly ? { managedOnly } : {}) }];
  });
}

/** One step's predicted account, as a check reports it. */
export interface StepRunAs {
  node_id: string;
  node_name: string;
  app: string;
  /** It runs only on a one-click (managed) account. */
  managed_only: boolean;
  decision: RunAsDecision;
}

/** The rule's dry run over a whole document: what each step would run as, for this runner and environment. */
export async function planRunAs(
  document: unknown,
  scope: RunAsScope,
  accounts: RunAsAccounts,
): Promise<StepRunAs[]> {
  const memo = memoized(accounts);
  const steps = stepsRunningAsAccounts(document);
  if (runsAsRunner(scope)) {
    await Promise.all([
      memo.ownConnections(
        scope.externalUserId,
        steps.flatMap((step) => step.connectionId ?? []),
      ),
      memo.accountsServing(
        scope.externalUserId,
        steps.map((step) => step.app),
      ),
    ]);
  }
  return Promise.all(
    steps.map(async (step) => ({
      node_id: step.nodeId,
      node_name: step.name,
      app: step.app,
      managed_only: step.managedOnly === true,
      decision: await decideRunAs(step, scope, memo),
    })),
  );
}

/** One step of a runner's Default plan, with the accounts a pick on it may offer. */
export interface StepRunAsOffer extends StepRunAs {
  /** The runner's active accounts that can run the step, newest first. */
  offered: string[];
}

/** {@link planRunAs} for a Default run, plus what each step's pick may offer — every lookup made once for both. */
export async function planForRunner(
  document: unknown,
  runner: string,
  accounts: RunAsAccounts,
): Promise<StepRunAsOffer[]> {
  const memo = memoized(accounts);
  const plan = await planRunAs(document, { externalUserId: runner }, memo);
  return Promise.all(
    plan.map(async (step) => ({
      ...step,
      offered: fitting(await memo.accountsServing(runner, [step.app]), {
        app: step.app,
        managedOnly: step.managed_only,
      }),
    })),
  );
}

// Each lookup runs once per dry run; the chosen accounts are read in one query and the serving ones in one more (#18).
function memoized(accounts: RunAsAccounts): RunAsAccounts {
  const cache = new Map<string, Promise<unknown>>();
  const serving = new Map<string, { apps: ReadonlySet<string>; read: Promise<ServingAccount[]> }>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      cache.set(key, hit);
    }
    return hit;
  };
  return {
    resolveSlotConnection: (environmentId, app) =>
      once(`slot:${environmentId}:${app}`, () => accounts.resolveSlotConnection(environmentId, app)),
    resolveClusterConnection: (orgId, environment, app) =>
      once(`cluster:${orgId}:${environment}:${app}`, () =>
        accounts.resolveClusterConnection(orgId, environment, app),
      ),
    environmentNameOf: (environmentId) =>
      once(`env:${environmentId}`, () => accounts.environmentNameOf(environmentId)),
    ownConnections: async (userId, connectionIds) => {
      const key = (id: string) => `own:${userId}:${id}`;
      const unread = [...new Set(connectionIds)].filter((id) => !cache.has(key(id)));
      if (unread.length > 0) {
        const read = accounts.ownConnections(userId, unread);
        for (const id of unread) {
          cache.set(
            key(id),
            read.then((found) => found.get(id) ?? null),
          );
        }
      }
      const found = await Promise.all(
        connectionIds.map(async (id) => [id, (await cache.get(key(id))) as OwnAccount | null] as const),
      );
      return new Map(found.flatMap(([id, own]) => (own ? [[id, own] as const] : [])));
    },
    accountsServing: (userId, apps) => {
      if (apps.length === 0) return Promise.resolve([]);
      const held = serving.get(userId);
      if (held && apps.every((app) => held.apps.has(app))) return held.read;
      const read = accounts.accountsServing(userId, [...new Set(apps)]);
      serving.set(userId, { apps: new Set(apps), read });
      return read;
    },
  };
}
