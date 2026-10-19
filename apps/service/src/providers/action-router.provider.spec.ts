import { DomainError } from '../common/domain-error';
import type { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import type { ConnectionsService, ManagedConnectionRef } from '../connections/connections.service';
import { COMPOSIO_DIRECT_APPS } from '../connections/managed-app-rails';
import { ActionRouterProvider } from './action-router.provider';
import { InMemoryStore } from './provider-store';
import { composioToolFor, isSdkActionType } from './sdk-actions.registry';
import { composioTriggerTypes, POLL_CURSOR_KEY } from './composio-trigger.registry';
import type { RunActionInput, TriggerInput } from './managed-integration-provider';
import type { SdkActionsProvider } from './sdk-actions.provider';
import { PlatformKeysService } from '../platform/platform-keys.service';

/** The router resolves a personal scope from the run's own externalUserId. */
const SCOPE = { kind: 'user', userId: 'user-1' } as const;

/** Scope resolution in these tests is fixed — they exercise routing, not key ownership. */
function platformKeysStub(): PlatformKeysService {
  return {
    scopeFor: (userId: string) => Promise.resolve({ kind: 'user' as const, userId }),
    composioApiKey: () => Promise.resolve(process.env.COMPOSIO_API_KEY ?? 'ak_test'),
  } as unknown as PlatformKeysService;
}

// There are exactly two rails: our SDK actions and Composio, else an honest error.
function build(opts: {
  managedRef?: ManagedConnectionRef | null;
  composioConfigured?: boolean;
  /** The org cluster connection resolveClusterConnection returns (default: none). */
  clusterConn?: { id: string; ownerUserId: string } | null;
  /** The env SLOT connection resolveSlotConnection returns (; default: none). */
  slotConn?: { id: string; ownerUserId: string } | null;
  /** The runner's own accounts for the step's app (default: none). */
  accounts?: string[];
  /** The app a chosen account is for (default: the app of the step being run). */
  chosenFor?: string;
}) {
  // Bare jest.fn()s so assertions reference the mock directly — the linter forbids an unbound class method.
  const execute = jest.fn().mockResolvedValue({ output: { via: 'composio' } });
  const executeBySlug = jest.fn().mockResolvedValue({ messages: [] });
  const runOurs = jest.fn().mockResolvedValue({ output: { via: 'sdk-actions' } });
  const managedRef = jest.fn().mockResolvedValue(opts.managedRef ?? null);
  let running = '';
  const managedRow = (opts.managedRef?.authType ?? 'managed') === 'managed';
  // A slot's account is for the step's app, and as one-click as the managed row the test gives.
  const slotAccount = (conn: { id: string; ownerUserId: string }, status: string) => ({
    status,
    provider: running,
    managed: managedRow,
    ...conn,
  });
  const resolveClusterConnection = jest.fn(() =>
    Promise.resolve(opts.clusterConn ? slotAccount(opts.clusterConn, 'active') : null),
  );
  const resolveSlotConnection = jest.fn(() =>
    Promise.resolve(opts.slotConn ? slotAccount(opts.slotConn, opts.managedRef?.status ?? 'active') : null),
  );
  // A chosen account is the runner's exactly when its managed row resolves for them, with that row's status.
  const ownConnections = jest.fn((_userId: string, ids: string[]) =>
    Promise.resolve(
      new Map(
        opts.managedRef
          ? ids.map((id) => [
              id,
              { provider: opts.chosenFor ?? running, status: opts.managedRef!.status, managed: managedRow },
            ])
          : [],
      ),
    ),
  );
  const accountsServing = jest.fn((_userId: string, apps: readonly string[]) =>
    Promise.resolve((opts.accounts ?? []).map((id) => ({ id, provider: apps[0], managed: managedRow }))),
  );

  const orchestrActions = {
    has: isSdkActionType,
    runAction: runOurs,
  } as unknown as SdkActionsProvider;
  const composio = {
    isConfigured: () => Promise.resolve(opts.composioConfigured ?? true),
    execute,
    executeBySlug,
  } as unknown as ComposioExecutionProvider;
  const connections = {
    managedRef,
    resolveClusterConnection,
    resolveSlotConnection,
    ownConnections,
    accountsServing,
    environmentNameOf: jest.fn().mockResolvedValue(null),
  } as unknown as ConnectionsService;
  const router = new ActionRouterProvider(orchestrActions, composio, connections, platformKeysStub());
  const runAction = router.runAction.bind(router);
  jest.spyOn(router, 'runAction').mockImplementation((step) => {
    running = step.actionId.split('.')[0] ?? '';
    return runAction(step);
  });
  return {
    router,
    execute,
    executeBySlug,
    runOurs,
    managedRef,
    resolveClusterConnection,
    resolveSlotConnection,
    accountsServing,
  };
}

// A real catalog entry that is NOT an SDK action — a genuine per-action gap, the universal fallback's target.
const COMPOSIO_ONLY = 'asana.get_current_user';
// A real catalog entry of an app the SDK ships no action for.
const TRELLO_CATALOG = 'trello.add_boards';
// A type of that same app that is in neither registry, so the commit check refuses it too.
const TRELLO_UNKNOWN = 'trello.get_card';
// SDK-owned AND in the Composio catalog — both rails could run it.
const BOTH_RAILS = 'jira.search_issues';

const input = (
  actionId: string,
  connectionId?: string,
  env?: { environment?: string; environmentId?: string; orgId?: string },
): RunActionInput => ({
  externalUserId: 'user-1',
  actionId,
  props: { foo: 'bar' },
  auth: connectionId ? { connectionId } : undefined,
  ...(env ?? {}),
});

const managed = (over: Partial<ManagedConnectionRef> = {}): ManagedConnectionRef => ({
  id: 'conn-1',
  authType: 'managed',
  status: 'active',
  connectedAccountId: 'ca__1',
  ...over,
});

describe('ActionRouterProvider', () => {
  it('routes an SDK action to OUR provider FIRST — before every Composio rail', async () => {
    // slack is on NO Composio-direct rail, so ours wins even on a managed connection.
    const { router, execute, runOurs } = build({ managedRef: managed() });
    const out = await router.runAction(input('slack.send_channel_message', 'conn-1'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['mailchimp.list_audiences', 'zendesk.list_tickets', 'intercom.list_contacts'])(
    'a managed %s step runs on OUR action — no app-wide Composio allowlist pre-empts it',
    async (type) => {
      const { router, execute, runOurs } = build({ managedRef: managed() });
      const out = await router.runAction(input(type, 'conn-1'));
      expect(out).toEqual({ output: { via: 'sdk-actions' } });
      expect(runOurs).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  // ─── Rail (a0): COMPOSIO-DIRECT apps — a MANAGED connection goes via Composio before
  //     every other rail; BYO/none keeps the SDK rail. ───

  it('routes EVERY googleapis app on a managed connection through Composio typed execution', async () => {
    for (const type of [
      'gmail.get_profile',
      'sheets.read_range',
      'docs.read_document',
      'calendar.delete_event',
      'drive.list_files',
    ]) {
      const { router, execute, runOurs } = build({ managedRef: managed() });
      const out = await router.runAction(input(type, 'conn-1'));
      expect(out).toEqual({ output: { via: 'composio' } });
      const [appSlug, actionName] = type.split('.');
      expect(execute).toHaveBeenCalledWith({
        scope: SCOPE,
        appSlug,
        actionName,
        props: { foo: 'bar' },
        connectedAccountId: 'ca__1',
        userId: 'user-1',
        tool: composioToolFor(type),
      });
      expect(runOurs).not.toHaveBeenCalled();
    }
  });

  it('a managed gmail SDK action (the 401 repro, gmail.get_profile) goes Composio-direct, not the SDK rail', async () => {
    const { router, execute, runOurs, managedRef } = build({ managedRef: managed() });
    const out = await router.runAction(input('gmail.get_profile', 'conn-1'));
    expect(out).toEqual({ output: { via: 'composio' } });
    expect(runOurs).not.toHaveBeenCalled();
    // The route decision resolved the ref once and reused it (no double lookup).
    expect(managedRef).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a BYO googleapis connection keeps the SDK rail (a real token needs no proxy)', async () => {
    const { router, execute, runOurs } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    const out = await router.runAction(input('gmail.get_profile', 'conn-1'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a googleapis step with no account chosen runs as the runner’s only one, on the rail that account takes', async () => {
    const { router, execute, runOurs } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
      accounts: ['only-gmail'],
    });
    const out = await router.runAction(input('gmail.get_profile'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'only-gmail' }, externalUserId: 'user-1' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('a step with no account to run as is refused naming it, before any rail runs', async () => {
    const { router, execute, runOurs } = build({});
    const refused = router.runAction({ ...input('gmail.get_profile'), stepName: 'Who am I' });
    await expect(refused).rejects.toThrow('Step "Who am I" has no gmail account to run as — connect one');
    expect(runOurs).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── Rail (b): universal Composio fallback — every routable type no SDK action owns. ───

  it('routes a Composio-only action on a managed connection through the universal fallback', async () => {
    const { router, execute, runOurs } = build({ managedRef: managed() });
    const out = await router.runAction(input(COMPOSIO_ONLY, 'conn-1'));
    expect(out).toEqual({ output: { via: 'composio' } });
    expect(runOurs).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({
      scope: SCOPE,
      appSlug: 'asana',
      actionName: 'get_current_user',
      props: { foo: 'bar' },
      connectedAccountId: 'ca__1',
      userId: 'user-1',
      // The EXACT catalog tool is passed so execution routes by slug, not name.
      tool: composioToolFor(COMPOSIO_ONLY),
    });
  });

  it('a catalog type of an app with no SDK action (trello) runs on the universal fallback', async () => {
    const { router, execute, runOurs } = build({ managedRef: managed() });
    const out = await router.runAction(input(TRELLO_CATALOG, 'conn-1'));
    expect(out).toEqual({ output: { via: 'composio' } });
    expect(runOurs).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        appSlug: 'trello',
        actionName: 'add_boards',
        tool: composioToolFor(TRELLO_CATALOG),
      }),
    );
  });

  it('the SDK action wins over the universal fallback when both could run it', async () => {
    const { router, execute, runOurs } = build({ managedRef: managed() });
    const out = await router.runAction(input(BOTH_RAILS, 'conn-1'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('drops idempotencyKey on the Composio typed rail (accepted at-least-once) — and never errors for it', async () => {
    const { router, execute } = build({ managedRef: managed() });
    const withKey: RunActionInput = {
      ...input(COMPOSIO_ONLY, 'conn-1'),
      idempotencyKey: 'user-1:run-7:n1',
    };
    const out = await router.runAction(withKey); // must not throw for lacking a key
    expect(out).toEqual({ output: { via: 'composio' } });
    // Composio's tool-execute has no idempotency param → the key is deliberately not forwarded.
    expect(execute).toHaveBeenCalledWith(expect.not.objectContaining({ idempotencyKey: expect.anything() }));
  });

  it('a dry run skips Composio typed execution — returns a stub, execute not called', async () => {
    const { router, execute } = build({ managedRef: managed() });
    const dry: RunActionInput = { ...input(COMPOSIO_ONLY, 'conn-1'), dryRun: true };
    const out = await router.runAction(dry);
    expect(out.output).toMatchObject({ dry_run: true, withheld: 'managed_step' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('a dry run predicts the real one: a step with no account to run as is refused there too', async () => {
    const { router, execute } = build({});
    const dry: RunActionInput = { ...input(COMPOSIO_ONLY), dryRun: true };
    await expect(router.runAction(dry)).rejects.toThrow(
      /runs only on a one-click \(managed\) asana account, and you have none/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a managed connection that is not active yet, naming the step and the fix — never its id', async () => {
    const { router, execute } = build({ managedRef: managed({ status: 'pending' }) });
    const err = await router.runAction(input(TRELLO_CATALOG, 'conn-1')).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'Step "trello.add_boards" runs as a trello account that isn\'t active — pick another of your trello accounts on the step',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a Composio-only action on an own-credentials account before any rail, naming the step', async () => {
    const { router, execute } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    await expect(
      router.runAction({ ...input(COMPOSIO_ONLY, 'conn-1'), stepName: 'Who am I' }),
    ).rejects.toMatchObject({
      status: 422,
      message:
        'Step "Who am I" runs as an account that uses its own credentials, and it runs only on a one-click (managed) asana account — pick one on the step, or connect one under Integrations',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks for a one-click account when a Composio-only action has none to run as', async () => {
    const { router, execute, accountsServing } = build({});
    await expect(router.runAction(input(COMPOSIO_ONLY))).rejects.toThrow(
      'Step "asana.get_current_user" runs only on a one-click (managed) asana account, and you have none — connect one under Integrations',
    );
    expect(accountsServing).toHaveBeenCalledWith('user-1', ['asana']);
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── An unroutable type: the commit check's own refusal, before any rail or connection lookup. ───

  it('throws an honest DomainError when nothing anywhere can run the action', async () => {
    const { router, execute } = build({});
    await expect(router.runAction(input('nope.definitely_not_real', 'conn-1'))).rejects.toThrow(
      /No installed rail can run "nope\.definitely_not_real"/,
    );
    await expect(router.runAction(input('nope.definitely_not_real', 'conn-1'))).rejects.toBeInstanceOf(
      DomainError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['managed', managed()],
    ['BYO', managed({ authType: 'oauth2', connectedAccountId: null })],
  ] as const)(
    'an unknown type of an app Composio runs (trello.get_card) is the same 400 on a %s connection',
    async (_label, ref) => {
      const { router, execute, runOurs, managedRef } = build({ managedRef: ref });
      const failure = router.runAction(input(TRELLO_UNKNOWN, 'conn-1'));
      await expect(failure).rejects.toThrow(
        'No installed rail can run "trello.get_card" — it is neither an SDK action nor in the managed (Composio) catalog',
      );
      await expect(failure).rejects.toMatchObject({ status: 400 });
      expect(managedRef).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(runOurs).not.toHaveBeenCalled();
    },
  );

  it('an unknown type with no connection is the same 400', async () => {
    const { router } = build({});
    await expect(router.runAction(input(TRELLO_UNKNOWN))).rejects.toThrow(/No installed rail can run/);
  });

  it('an unknown type of a COMPOSIO-DIRECT app is the same 400, never a fuzzy Composio match', async () => {
    const { router, execute, managedRef } = build({ managedRef: managed() });
    await expect(router.runAction(input('gmail.not_a_real_action', 'conn-1'))).rejects.toThrow(
      /No installed rail can run "gmail\.not_a_real_action"/,
    );
    expect(managedRef).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('throws a malformed-id error for an id with no app slug', async () => {
    const { router } = build({});
    await expect(router.runAction(input('nodots'))).rejects.toThrow(/Malformed action id/);
  });

  // ─── Per-env connection scoping: an env-deployed run swaps in the slot
  //     connection and runs AS its owner. Observed via the SDK rail. ───

  const PROD = { environment: 'prod', orgId: 'org-1' };

  it('env run swaps the step connection for the org cluster connection, run AS its owner', async () => {
    const { router, runOurs, resolveClusterConnection } = build({
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
    });
    await router.runAction(input('slack.send_channel_message', 'personal-conn', PROD));
    expect(resolveClusterConnection).toHaveBeenCalledWith('org-1', 'prod', 'slack');
    // The downstream rail sees the CLUSTER connection + the OWNER identity.
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'cluster-conn' }, externalUserId: 'owner-9' }),
    );
  });

  it('env run with no cluster connection for the app is a hard 428 (never the author personal one)', async () => {
    const { router, runOurs } = build({ clusterConn: null });
    await expect(
      router.runAction(input('slack.send_channel_message', 'personal-conn', PROD)),
    ).rejects.toThrow(/^prod has no slack account assigned/);
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('a TEST run (no environment) keeps the step personal connection + identity untouched', async () => {
    const { router, runOurs, resolveClusterConnection } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    await router.runAction(input('slack.send_channel_message', 'personal-conn'));
    expect(resolveClusterConnection).not.toHaveBeenCalled();
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'personal-conn' }, externalUserId: 'user-1' }),
    );
  });

  it('an env run takes the slot for a step that names NO account too, run AS its owner', async () => {
    const { router, runOurs, resolveClusterConnection, accountsServing } = build({
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
      accounts: ['runner-gmail'],
    });
    await router.runAction(input('gmail.get_profile', undefined, PROD));
    expect(resolveClusterConnection).toHaveBeenCalledWith('org-1', 'prod', 'gmail');
    expect(accountsServing).not.toHaveBeenCalled();
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'cluster-conn' }, externalUserId: 'owner-9' }),
    );
  });

  it('a step that needs no account and names none is left untouched under an environment', async () => {
    const { router, runOurs, resolveClusterConnection } = build({
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
    });
    await router.runAction(input('text.concat', undefined, PROD));
    expect(resolveClusterConnection).not.toHaveBeenCalled();
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined, externalUserId: 'user-1' }),
    );
  });

  const STAGING_SLOT = { environment: 'staging', environmentId: 'env-42', orgId: 'org-1' };

  it('an env run with environment_id rebinds the step through the SLOT, run AS its owner', async () => {
    const { router, runOurs, resolveSlotConnection, resolveClusterConnection } = build({
      slotConn: { id: 'slot-conn', ownerUserId: 'owner-7' },
    });
    await router.runAction(input('slack.send_channel_message', 'personal-conn', STAGING_SLOT));
    expect(resolveSlotConnection).toHaveBeenCalledWith('env-42', 'slack');
    expect(resolveClusterConnection).not.toHaveBeenCalled(); // the id path never touches the legacy key
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'slot-conn' }, externalUserId: 'owner-7' }),
    );
  });

  it.each<[string, typeof STAGING_SLOT | undefined, Parameters<typeof build>[0]]>([
    ['Default, with an only account', undefined, { accounts: ['mine'] }],
    ['Default, with no account', undefined, {}],
    ['an environment, with a slot', STAGING_SLOT, { slotConn: { id: 'slot-conn', ownerUserId: 'owner-7' } }],
  ])(
    'a credential handed inline runs as handed on %s — never swapped for an account',
    async (_label, env, opts) => {
      const { router, runOurs, accountsServing, resolveSlotConnection } = build(opts);
      await router.runAction({
        ...input('slack.send_channel_message', undefined, env),
        auth: { token: 'inline' },
      });
      expect(runOurs).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { token: 'inline' }, externalUserId: 'user-1' }),
      );
      expect(accountsServing).not.toHaveBeenCalled();
      expect(resolveSlotConnection).not.toHaveBeenCalled();
    },
  );

  it('a MISSING slot is a hard 428 naming the env + app — never the pool', async () => {
    const { router, runOurs } = build({
      slotConn: null,
      // Even a legacy cluster row must NOT rescue an id-keyed run — no borrowing.
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
    });
    await expect(
      router.runAction(input('slack.send_channel_message', 'personal-conn', STAGING_SLOT)),
    ).rejects.toThrow(/^staging has no slack account assigned/);
    await expect(
      router.runAction(input('slack.send_channel_message', 'personal-conn', STAGING_SLOT)),
    ).rejects.toMatchObject({ status: 428 });
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('an unknown type in an env run with no slot is the commit check’s 400, before any slot lookup', async () => {
    const { router, resolveSlotConnection, resolveClusterConnection, managedRef } = build({ slotConn: null });
    const failure = router.runAction(input(TRELLO_UNKNOWN, 'personal-conn', STAGING_SLOT));
    await expect(failure).rejects.toThrow(/No installed rail can run "trello\.get_card"/);
    await expect(failure).rejects.toMatchObject({ status: 400 });
    expect(resolveSlotConnection).not.toHaveBeenCalled();
    expect(resolveClusterConnection).not.toHaveBeenCalled();
    expect(managedRef).not.toHaveBeenCalled();
  });

  it("an environment's account that isn't active is refused before any rail, naming the environment, the step and the fix", async () => {
    const { router, execute, managedRef } = build({
      slotConn: { id: 'slot-conn', ownerUserId: 'owner-7' },
      managedRef: managed({ id: 'slot-conn', status: 'expired' }),
    });
    const err = await router
      .runAction({ ...input(TRELLO_CATALOG, 'personal-conn', STAGING_SLOT), stepName: 'Add a board' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 428,
      message:
        "staging's trello account isn't active, so \"Add a board\" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments",
    });
    expect(managedRef).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('a chosen account for another app is refused before any rail, naming both apps', async () => {
    const { router, execute, runOurs } = build({ managedRef: managed(), chosenFor: 'slack' });
    const err = await router
      .runAction({ ...input('gmail.get_profile', 'conn-1'), stepName: 'Who am I' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 422,
      message:
        'Step "Who am I" runs as an account for slack, not gmail — pick one of your gmail accounts on the step',
    });
    expect(runOurs).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('a Default run (no env context) never touches slot or cluster resolution', async () => {
    const { router, runOurs, resolveSlotConnection, resolveClusterConnection } = build({
      slotConn: { id: 'slot-conn', ownerUserId: 'owner-7' },
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    await router.runAction(input('slack.send_channel_message', 'personal-conn'));
    expect(resolveSlotConnection).not.toHaveBeenCalled();
    expect(resolveClusterConnection).not.toHaveBeenCalled();
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'personal-conn' }, externalUserId: 'user-1' }),
    );
  });
});

// ─── Trigger routing: a MANAGED connection with a registry spec polls via Composio
//     with TIMEBASED cursor semantics; anything else is unsupported. ───

const GMAIL_TRIGGER = 'gmail.gmail_new_email_received';

/** A gmail message in the live GMAIL_FETCH_EMAILS shape (epoch ms → ISO). */
const message = (epochMs: number, subject: string): Record<string, unknown> => ({
  messageId: `m-${epochMs}`,
  threadId: `t-${epochMs}`,
  messageTimestamp: new Date(epochMs).toISOString(),
  subject,
  sender: 'someone@example.com',
});

const triggerInput = (over: Partial<TriggerInput> = {}): TriggerInput => ({
  externalUserId: 'user-1',
  triggerId: GMAIL_TRIGGER,
  props: { subject: 'invoice' },
  auth: { connectionId: 'conn-1' },
  store: new InMemoryStore(),
  ...over,
});

describe('ActionRouterProvider trigger routing', () => {
  it('every Composio-polled trigger belongs to a COMPOSIO_DIRECT app (rails consistency)', () => {
    for (const type of composioTriggerTypes()) {
      const slug = type.slice(0, type.indexOf('.'));
      expect(COMPOSIO_DIRECT_APPS.has(slug)).toBe(true);
    }
  });

  it('enableTrigger for a managed gmail trigger seeds the cursor at "now"', async () => {
    const { router } = build({ managedRef: managed() });
    const inp = triggerInput();
    const before = Date.now();
    await router.enableTrigger(inp);
    const cursor = await inp.store.get<number>(POLL_CURSOR_KEY);
    expect(cursor).toBeGreaterThanOrEqual(before);
    expect(cursor).toBeLessThanOrEqual(Date.now());
  });

  it('disableTrigger for a managed gmail trigger is a no-op that resolves', async () => {
    const { router } = build({ managedRef: managed() });
    await expect(router.disableTrigger(triggerInput())).resolves.toBeUndefined();
  });

  it('a NON-registry trigger is unsupported: enable/poll throw, disable is a no-op', async () => {
    const { router, executeBySlug } = build({ managedRef: managed() });
    const inp = triggerInput({ triggerId: 'rss.new-item', props: { rss_feed_url: 'http://x' } });
    await expect(router.enableTrigger(inp)).rejects.toThrow(/no longer supported/i);
    await expect(router.pollTrigger(inp)).rejects.toThrow(/no longer supported/i);
    await expect(router.disableTrigger(inp)).resolves.toBeUndefined();
    expect(executeBySlug).not.toHaveBeenCalled();
  });

  it('a BYO gmail trigger is unsupported (Composio needs a managed connection to poll)', async () => {
    const { router, executeBySlug } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    await expect(router.enableTrigger(triggerInput())).rejects.toMatchObject({ status: 428 });
    await expect(router.pollTrigger(triggerInput())).rejects.toThrow(/managed connection/i);
    expect(executeBySlug).not.toHaveBeenCalled();
  });

  it('polls gmail via GMAIL_FETCH_EMAILS: props + cursor → query, only STRICTLY newer items fire, oldest first', async () => {
    const { router, executeBySlug } = build({ managedRef: managed() });
    const cursor = Date.UTC(2026, 6, 12, 12, 0, 0); // enable-time cursor
    const inp = triggerInput();
    await inp.store.put(POLL_CURSOR_KEY, cursor);

    // Scrambled order, one item at the cursor boundary (must NOT refire) and two strictly newer.
    executeBySlug.mockResolvedValueOnce({
      messages: [
        message(cursor + 8_000, 'invoice #2'),
        message(cursor, 'boundary — already seen'),
        message(cursor + 5_000, 'invoice #1'),
      ],
    });
    const events = await router.pollTrigger(inp);

    expect(executeBySlug).toHaveBeenCalledWith(SCOPE, 'GMAIL_FETCH_EMAILS', {
      connectedAccountId: 'ca__1',
      userId: 'user-1',
      arguments: {
        query: `subject:(invoice) after:${Math.floor(cursor / 1000)}`,
        max_results: 20,
      },
    });
    // Oldest first, boundary item deduped.
    expect(events.map((e) => (e.payload as { subject: string }).subject)).toEqual([
      'invoice #1',
      'invoice #2',
    ]);
    // The cursor advanced to the newest seen epoch.
    expect(await inp.store.get<number>(POLL_CURSOR_KEY)).toBe(cursor + 8_000);
  });

  it('a re-poll of the same window fires nothing (no refire of seen items)', async () => {
    const { router, executeBySlug } = build({ managedRef: managed() });
    const cursor = Date.UTC(2026, 6, 12, 12, 0, 0);
    const inp = triggerInput();
    await inp.store.put(POLL_CURSOR_KEY, cursor);

    const window = { messages: [message(cursor + 5_000, 'invoice #1')] };
    executeBySlug.mockResolvedValue(window);
    expect(await router.pollTrigger(inp)).toHaveLength(1);
    expect(await router.pollTrigger(inp)).toEqual([]); // same items again → deduped
    expect(await inp.store.get<number>(POLL_CURSOR_KEY)).toBe(cursor + 5_000);
  });

  it('an empty poll is a no-op: no events, cursor unchanged', async () => {
    const { router, executeBySlug } = build({ managedRef: managed() });
    const cursor = Date.UTC(2026, 6, 12, 12, 0, 0);
    const inp = triggerInput();
    await inp.store.put(POLL_CURSOR_KEY, cursor);
    executeBySlug.mockResolvedValueOnce({ messages: [] });
    expect(await router.pollTrigger(inp)).toEqual([]);
    expect(await inp.store.get<number>(POLL_CURSOR_KEY)).toBe(cursor);
  });

  it('a cursor-less first poll samples a small window (max_results 5, no after:) and seeds the cursor', async () => {
    const { router, executeBySlug } = build({ managedRef: managed() });
    const inp = triggerInput({ props: {} });
    const newest = Date.UTC(2026, 6, 12, 12, 0, 30);
    executeBySlug.mockResolvedValueOnce({
      messages: [message(newest, 'b'), message(newest - 10_000, 'a')],
    });
    const events = await router.pollTrigger(inp);
    // No cursor and no props → no query at all, and a small first window.
    expect(executeBySlug).toHaveBeenCalledWith(SCOPE, 'GMAIL_FETCH_EMAILS', {
      connectedAccountId: 'ca__1',
      userId: 'user-1',
      arguments: { max_results: 5 },
    });
    expect(events).toHaveLength(2); // epoch > 0 — everything fires on the first window
    expect(await inp.store.get<number>(POLL_CURSOR_KEY)).toBe(newest);
  });

  it('a Composio failure propagates out of pollTrigger (the poller records it on last_error)', async () => {
    const { router, executeBySlug } = build({ managedRef: managed() });
    executeBySlug.mockRejectedValueOnce(new DomainError('GMAIL_FETCH_EMAILS failed: quota exceeded', 422));
    await expect(router.pollTrigger(triggerInput())).rejects.toThrow(/quota exceeded/);
  });

  it('a managed-but-inactive connection is an honest poll error, not a Composio call', async () => {
    const { router, executeBySlug } = build({ managedRef: managed({ status: 'pending' }) });
    await expect(router.pollTrigger(triggerInput())).rejects.toThrow(/not active/i);
    expect(executeBySlug).not.toHaveBeenCalled();
  });

  it('an unconfigured Composio is an honest poll error for a managed registry trigger', async () => {
    const { router, executeBySlug } = build({ managedRef: managed(), composioConfigured: false });
    await expect(router.pollTrigger(triggerInput())).rejects.toThrow(/no Composio API key is set/i);
    expect(executeBySlug).not.toHaveBeenCalled();
  });
});
