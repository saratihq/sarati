import type { ConfigService } from '@nestjs/config';

import { DomainError } from '../common/domain-error';
import type { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import type { ConnectionsService, ManagedConnectionRef } from '../connections/connections.service';
import { COMPOSIO_DIRECT_APPS } from '../connections/managed-app-rails';
import type { EnvConfig } from '../config/env.config';
import { ActionRouterProvider } from './action-router.provider';
import { InMemoryStore } from './provider-store';
import { composioToolFor } from './sdk-actions.registry';
import { composioTriggerTypes, POLL_CURSOR_KEY } from './composio-trigger.registry';
import type { RunActionInput, TriggerInput } from './managed-integration-provider';
import type { SdkActionsProvider } from './sdk-actions.provider';

// There are exactly two rails: our SDK actions and Composio, else an honest error.
function build(opts: {
  fallbackApps?: string;
  managedRef?: ManagedConnectionRef | null;
  composioConfigured?: boolean;
  /** Public types the SDK owns for this test (default: none → nothing routes to ours). */
  sdkTypes?: string[];
  /** The org cluster connection resolveClusterConnection returns (default: none). */
  clusterConn?: { id: string; ownerUserId: string } | null;
  /** The env SLOT connection resolveSlotConnection returns (ADR 0014; default: none). */
  slotConn?: { id: string; ownerUserId: string } | null;
}) {
  // Bare jest.fn()s so assertions reference the mock directly — the linter forbids an unbound class method.
  const execute = jest.fn().mockResolvedValue({ output: { via: 'composio' } });
  const executeBySlug = jest.fn().mockResolvedValue({ messages: [] });
  const runOurs = jest.fn().mockResolvedValue({ output: { via: 'sdk-actions' } });
  const managedRef = jest.fn().mockResolvedValue(opts.managedRef ?? null);
  const resolveClusterConnection = jest.fn().mockResolvedValue(opts.clusterConn ?? null);
  const resolveSlotConnection = jest.fn().mockResolvedValue(opts.slotConn ?? null);

  const sdkTypes = new Set(opts.sdkTypes ?? []);
  const orchestrActions = {
    has: (type: string) => sdkTypes.has(type),
    runAction: runOurs,
  } as unknown as SdkActionsProvider;
  const composio = {
    configured: opts.composioConfigured ?? true,
    execute,
    executeBySlug,
  } as unknown as ComposioExecutionProvider;
  const connections = {
    managedRef,
    resolveClusterConnection,
    resolveSlotConnection,
  } as unknown as ConnectionsService;
  const config = {
    get: () => ({ composioFallbackApps: opts.fallbackApps ?? '' }) as Partial<EnvConfig>,
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  const router = new ActionRouterProvider(orchestrActions, composio, connections, config);
  return {
    router,
    execute,
    executeBySlug,
    runOurs,
    managedRef,
    resolveClusterConnection,
    resolveSlotConnection,
  };
}

// A real catalog entry that is NOT an SDK action — a genuine per-action gap, the universal fallback's target.
const COMPOSIO_ONLY = 'asana.get_current_user';

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
    // github is on NO Composio-direct rail, so ours wins even on a managed connection.
    const { router, execute, runOurs } = build({
      sdkTypes: ['github.create_issue'],
      managedRef: managed(),
    });
    const out = await router.runAction(input('github.create_issue', 'conn-1'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── Rail (a0): COMPOSIO-DIRECT apps — a MANAGED connection goes via Composio before
  //     every other rail; BYO/none keeps the SDK rail. ───

  it('routes EVERY googleapis app on a managed connection through Composio typed execution', async () => {
    for (const slug of ['gmail', 'sheets', 'docs', 'calendar', 'drive']) {
      const { router, execute, runOurs } = build({
        sdkTypes: [`${slug}.get_thing`],
        managedRef: managed(),
      });
      const out = await router.runAction(input(`${slug}.get_thing`, 'conn-1'));
      expect(out).toEqual({ output: { via: 'composio' } });
      expect(execute).toHaveBeenCalledWith({
        appSlug: slug,
        actionName: 'get_thing',
        props: { foo: 'bar' },
        connectedAccountId: 'ca__1',
        userId: 'user-1',
      });
      expect(runOurs).not.toHaveBeenCalled();
    }
  });

  it('a managed gmail SDK action (the 401 repro, gmail.get_profile) goes Composio-direct, not the SDK rail', async () => {
    const { router, execute, runOurs, managedRef } = build({
      sdkTypes: ['gmail.get_profile'],
      managedRef: managed(),
    });
    const out = await router.runAction(input('gmail.get_profile', 'conn-1'));
    expect(out).toEqual({ output: { via: 'composio' } });
    expect(runOurs).not.toHaveBeenCalled();
    // The route decision resolved the ref once and reused it (no double lookup).
    expect(managedRef).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a BYO googleapis connection keeps the SDK rail (a real token needs no proxy)', async () => {
    const { router, execute, runOurs } = build({
      sdkTypes: ['gmail.get_profile'],
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    const out = await router.runAction(input('gmail.get_profile', 'conn-1'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a googleapis step with NO connection falls through to the SDK rail (its honest 422)', async () => {
    const { router, execute, runOurs, managedRef } = build({ sdkTypes: ['gmail.get_profile'] });
    const out = await router.runAction(input('gmail.get_profile'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(managedRef).not.toHaveBeenCalled(); // no connection id → no lookup
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── Rail (b): TRANSPORT-GAP apps — a managed connection runs via Composio. ───

  it('routes a TRANSPORT-GAP app on a managed connection through Composio', async () => {
    const { router, execute } = build({ managedRef: managed() });
    const out = await router.runAction(input('jira.search_issues', 'conn-1'));
    expect(out).toEqual({ output: { via: 'composio' } });
    expect(execute).toHaveBeenCalledWith({
      appSlug: 'jira',
      actionName: 'search_issues',
      props: { foo: 'bar' },
      connectedAccountId: 'ca__1',
      userId: 'user-1',
      // The EXACT catalog tool is passed so execution routes by slug, not name.
      tool: composioToolFor('jira.search_issues'),
    });
  });

  it('drops idempotencyKey on the Composio typed rail (accepted at-least-once, ADR 0040) — and never errors for it', async () => {
    const { router, execute } = build({ managedRef: managed() });
    const withKey: RunActionInput = {
      ...input('jira.search_issues', 'conn-1'),
      idempotencyKey: 'user-1:run-7:n1',
    };
    const out = await router.runAction(withKey); // must not throw for lacking a key
    expect(out).toEqual({ output: { via: 'composio' } });
    // Composio's tool-execute has no idempotency param → the key is deliberately not forwarded.
    expect(execute).toHaveBeenCalledWith(expect.not.objectContaining({ idempotencyKey: expect.anything() }));
  });

  it('a dry run skips Composio typed execution — returns a stub, execute not called, no connection needed (ADR 0041)', async () => {
    const { router, execute } = build({}); // no managed connection at all
    const dry: RunActionInput = { ...input('jira.search_issues'), dryRun: true };
    const out = await router.runAction(dry);
    expect(out.output).toMatchObject({ dry_run: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('honours the COMPOSIO_FALLBACK_APPS override (forces slack onto Composio)', async () => {
    const { router, execute } = build({ fallbackApps: 'slack', managedRef: managed() });
    await router.runAction(input('slack.list_users', 'conn-1'));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a fallback-only app on a BYO connection with an honest error', async () => {
    const { router, execute } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    await expect(router.runAction(input('trello.get_card', 'conn-1'))).rejects.toThrow(
      /needs a managed connection/i,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a fallback-only step that references no connection', async () => {
    const { router } = build({});
    await expect(router.runAction(input('trello.get_card'))).rejects.toBeInstanceOf(DomainError);
  });

  it('refuses a managed connection that is not active yet', async () => {
    const { router } = build({ managedRef: managed({ status: 'pending' }) });
    await expect(router.runAction(input('zendesk.find_tickets', 'conn-1'))).rejects.toThrow(/not active/i);
  });

  // ─── Rail (c): universal Composio fallback — only after (a) and (b) decline. ───

  it('routes a Composio-only action on a managed connection through the universal fallback', async () => {
    const { router, execute, runOurs } = build({ managedRef: managed() });
    const out = await router.runAction(input(COMPOSIO_ONLY, 'conn-1'));
    expect(out).toEqual({ output: { via: 'composio' } });
    expect(runOurs).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({
      appSlug: 'asana',
      actionName: 'get_current_user',
      props: { foo: 'bar' },
      connectedAccountId: 'ca__1',
      userId: 'user-1',
      // The EXACT catalog tool is passed so execution routes by slug, not name.
      tool: composioToolFor(COMPOSIO_ONLY),
    });
  });

  it('the SDK action wins over the universal fallback when both could run it', async () => {
    const { router, execute, runOurs } = build({ sdkTypes: [COMPOSIO_ONLY], managedRef: managed() });
    const out = await router.runAction(input(COMPOSIO_ONLY, 'conn-1'));
    expect(out).toEqual({ output: { via: 'sdk-actions' } });
    expect(runOurs).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives a Composio-only action on a BYO connection the honest managed-only error', async () => {
    const { router, execute } = build({
      managedRef: managed({ authType: 'oauth2', connectedAccountId: null }),
    });
    await expect(router.runAction(input(COMPOSIO_ONLY, 'conn-1'))).rejects.toThrow(
      /needs a managed connection/i,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks for a managed connection when a Composio-only action references none', async () => {
    const { router, execute } = build({});
    await expect(router.runAction(input(COMPOSIO_ONLY))).rejects.toThrow(/managed connection/i);
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── Rail (d): honest error — no SDK action and no Composio home for the app. ───

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

  it('throws a malformed-id error for an id with no app slug', async () => {
    const { router } = build({});
    await expect(router.runAction(input('nodots'))).rejects.toThrow(/Malformed action id/);
  });

  // ─── Per-env connection scoping (ADR 0014): an env-deployed run swaps in the slot
  //     connection and runs AS its owner. Observed via the SDK rail. ───

  const PROD = { environment: 'prod', orgId: 'org-1' };

  it('env run swaps the step connection for the org cluster connection, run AS its owner', async () => {
    const { router, runOurs, resolveClusterConnection } = build({
      sdkTypes: ['slack.list_users'],
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
    });
    await router.runAction(input('slack.list_users', 'personal-conn', PROD));
    expect(resolveClusterConnection).toHaveBeenCalledWith('org-1', 'prod', 'slack');
    // The downstream rail sees the CLUSTER connection + the OWNER identity.
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'cluster-conn' }, externalUserId: 'owner-9' }),
    );
  });

  it('env run with no cluster connection for the app is a hard 428 (never the author personal one)', async () => {
    const { router, runOurs } = build({ sdkTypes: ['slack.list_users'], clusterConn: null });
    await expect(router.runAction(input('slack.list_users', 'personal-conn', PROD))).rejects.toThrow(
      /No "slack" connection in the prod environment/i,
    );
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('a TEST run (no environment) keeps the step personal connection + identity untouched', async () => {
    const { router, runOurs, resolveClusterConnection } = build({ sdkTypes: ['slack.list_users'] });
    await router.runAction(input('slack.list_users', 'personal-conn'));
    expect(resolveClusterConnection).not.toHaveBeenCalled();
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'personal-conn' }, externalUserId: 'user-1' }),
    );
  });

  it('an env run for a step that references NO connection is left untouched (no cluster lookup)', async () => {
    const { router, runOurs, resolveClusterConnection } = build({
      sdkTypes: ['slack.list_users'],
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
    });
    await router.runAction(input('slack.list_users', undefined, PROD));
    expect(resolveClusterConnection).not.toHaveBeenCalled();
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined, externalUserId: 'user-1' }),
    );
  });

  const STAGING_SLOT = { environment: 'staging', environmentId: 'env-42', orgId: 'org-1' };

  it('an env run with environment_id rebinds the step through the SLOT, run AS its owner', async () => {
    const { router, runOurs, resolveSlotConnection, resolveClusterConnection } = build({
      sdkTypes: ['slack.list_users'],
      slotConn: { id: 'slot-conn', ownerUserId: 'owner-7' },
    });
    await router.runAction(input('slack.list_users', 'personal-conn', STAGING_SLOT));
    expect(resolveSlotConnection).toHaveBeenCalledWith('env-42', 'slack');
    expect(resolveClusterConnection).not.toHaveBeenCalled(); // the id path never touches the legacy key
    expect(runOurs).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { connectionId: 'slot-conn' }, externalUserId: 'owner-7' }),
    );
  });

  it('a MISSING slot is a hard 428 naming the env + app — never the pool', async () => {
    const { router, runOurs } = build({
      sdkTypes: ['slack.list_users'],
      slotConn: null,
      // Even a legacy cluster row must NOT rescue an id-keyed run — no borrowing.
      clusterConn: { id: 'cluster-conn', ownerUserId: 'owner-9' },
    });
    await expect(router.runAction(input('slack.list_users', 'personal-conn', STAGING_SLOT))).rejects.toThrow(
      /No "slack" connection in the staging environment/i,
    );
    await expect(
      router.runAction(input('slack.list_users', 'personal-conn', STAGING_SLOT)),
    ).rejects.toMatchObject({ status: 428 });
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('a Default run (no env context) never touches slot or cluster resolution', async () => {
    const { router, runOurs, resolveSlotConnection, resolveClusterConnection } = build({
      sdkTypes: ['slack.list_users'],
      slotConn: { id: 'slot-conn', ownerUserId: 'owner-7' },
    });
    await router.runAction(input('slack.list_users', 'personal-conn'));
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

    expect(executeBySlug).toHaveBeenCalledWith('GMAIL_FETCH_EMAILS', {
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
    expect(executeBySlug).toHaveBeenCalledWith('GMAIL_FETCH_EMAILS', {
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
    await expect(router.pollTrigger(triggerInput())).rejects.toThrow(/not configured/i);
    expect(executeBySlug).not.toHaveBeenCalled();
  });
});
