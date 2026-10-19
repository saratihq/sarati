import type { AccountIdentity } from '../connections/account-identity';
import type { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import type { ConnectionsService, StoredAccount } from '../connections/connections.service';
import type { PlatformKeysService } from '../platform/platform-keys.service';
import { ActionRouterProvider } from './action-router.provider';
import type { RunActionInput } from './managed-integration-provider';
import type { SdkActionsProvider } from './sdk-actions.provider';

const MAILBOX: AccountIdentity = {
  subject: 'user',
  name: null,
  id: 'me@e2e.local',
  email: 'me@e2e.local',
  handle: null,
};

function build(
  stored: Record<string, StoredAccount>,
  slot?: { id: string; ownerUserId: string },
  /** The runner's own gmail accounts, for a step with none chosen. */
  own: string[] = [],
) {
  const runOurs = jest.fn((input: RunActionInput) =>
    Promise.resolve({
      output:
        input.actionId === 'gmail.get_profile' ? { emailAddress: 'probed@e2e.local' } : { sent: input.props },
    }),
  );
  const accountOf = jest.fn((userId: string, id: string) =>
    Promise.resolve(stored[`${userId}:${id}`] ?? null),
  );
  const recordAccount = jest.fn(() => Promise.resolve());
  const router = new ActionRouterProvider(
    {
      has: (type: string) => /^(?:gmail|slack|text)\./.test(type),
      runAction: runOurs,
    } as unknown as SdkActionsProvider,
    { isConfigured: () => Promise.resolve(false) } as unknown as ComposioExecutionProvider,
    {
      managedRef: () => Promise.resolve(null),
      resolveSlotConnection: (_env: string, app: string) =>
        Promise.resolve(slot ? { ...slot, status: 'active', provider: app, managed: false } : null),
      resolveClusterConnection: () => Promise.resolve(null),
      ownConnections: (userId: string, ids: string[]) =>
        Promise.resolve(
          new Map(
            ids.flatMap((id) => {
              const key = `${userId}:${id}`;
              if (key !== 'u1:c1' && !(key in stored)) return [];
              return [[id, { provider: stored[key]?.provider ?? 'gmail', status: 'active', managed: false }]];
            }),
          ),
        ),
      accountsServing: (_userId: string, apps: readonly string[]) =>
        Promise.resolve(own.map((id) => ({ id, provider: apps[0], managed: false }))),
      accountOf,
      recordAccount,
    } as unknown as ConnectionsService,
    {
      scopeFor: (userId: string) => Promise.resolve({ kind: 'user', userId }),
    } as unknown as PlatformKeysService,
  );
  return { router, runOurs, accountOf, recordAccount };
}

const send = (props: Record<string, unknown>, over: Partial<RunActionInput> = {}): RunActionInput => ({
  externalUserId: 'u1',
  actionId: 'gmail.send_email',
  props,
  auth: { connectionId: 'c1' },
  ...over,
});

// A real action of each app, so the account's app is the step's.
const ACTION_OF: Record<string, string> = {
  claude: 'claude.generate_text',
  gmail: 'gmail.send_email',
  slack: 'slack.send_channel_message',
};

const sentProps = (runOurs: jest.Mock): unknown => {
  const call = runOurs.mock.calls.find(
    ([input]) => (input as RunActionInput).actionId === 'gmail.send_email',
  );
  return (call?.[0] as RunActionInput | undefined)?.props;
};

describe('{{$account…}} in the action router', () => {
  it('fills the account the step runs as, from what the provider last said', async () => {
    const { router, runOurs } = build({
      'u1:c1': { provider: 'gmail', account: MAILBOX, checkedAt: new Date() },
    });
    await router.runAction(send({ to: '{{$account.email}}', subject: 'For {{$account.email}}' }));
    expect(sentProps(runOurs)).toEqual({ to: 'me@e2e.local', subject: 'For me@e2e.local' });
    expect(runOurs).toHaveBeenCalledTimes(1);
  });

  it('asks the provider when it never has, stores the answer, then fills — a dry run asks for real', async () => {
    const { router, runOurs, recordAccount } = build({
      'u1:c1': { provider: 'gmail', account: null, checkedAt: null },
    });
    await router.runAction(send({ to: '{{$account.email}}' }, { dryRun: true }));
    const probe = runOurs.mock.calls[0]?.[0] as RunActionInput;
    expect(probe).toMatchObject({ actionId: 'gmail.get_profile', auth: { connectionId: 'c1' } });
    expect(probe.dryRun).toBeUndefined();
    expect(recordAccount).toHaveBeenCalledWith('c1', expect.objectContaining({ email: 'probed@e2e.local' }));
    expect(sentProps(runOurs)).toEqual({ to: 'probed@e2e.local' });
  });

  it("reads the environment slot's account, as its owner — never the authored one", async () => {
    const { router, runOurs, accountOf } = build(
      {
        'u1:c1': { provider: 'gmail', account: MAILBOX, checkedAt: new Date() },
        'owner:slot': {
          provider: 'gmail',
          account: { ...MAILBOX, email: 'ops@e2e.local' },
          checkedAt: new Date(),
        },
      },
      { id: 'slot', ownerUserId: 'owner' },
    );
    await router.runAction(send({ to: '{{$account.email}}' }, { environmentId: 'env-1' }));
    expect(accountOf).toHaveBeenCalledWith('owner', 'slot');
    expect(sentProps(runOurs)).toEqual({ to: 'ops@e2e.local' });
  });

  it.each([
    [
      'an app Sarati cannot ask',
      { provider: 'claude', account: null, checkedAt: null },
      '{{$account.email}}',
      "can't tell which claude account",
    ],
    [
      'a workspace, not a person',
      { provider: 'slack', account: { ...MAILBOX, subject: 'workspace' as const }, checkedAt: new Date() },
      '{{$account.email}}',
      'which workspace this connection is in',
    ],
    [
      'a field no account has',
      { provider: 'gmail', account: MAILBOX, checkedAt: new Date() },
      '{{$account.phone}}',
      "isn't something Sarati knows",
    ],
    [
      'a field this provider does not share',
      { provider: 'gmail', account: MAILBOX, checkedAt: new Date() },
      '{{$account.handle}}',
      "doesn't share this account's handle",
    ],
  ])('fails the step before the action runs for %s', async (_case, stored, ref, message) => {
    const { router, runOurs } = build({ 'u1:c1': stored });
    const actionId = ACTION_OF[stored.provider]!;
    await expect(router.runAction(send({ to: ref }, { actionId }))).rejects.toThrow(message);
    expect(runOurs).not.toHaveBeenCalledWith(expect.objectContaining({ actionId }));
  });

  it('follows the account a step with none chosen runs as — the runner’s only one', async () => {
    const { router, runOurs, accountOf } = build(
      { 'u1:only': { provider: 'gmail', account: MAILBOX, checkedAt: new Date() } },
      undefined,
      ['only'],
    );
    await router.runAction(send({ to: '{{$account.email}}' }, { auth: undefined }));
    expect(accountOf).toHaveBeenCalledWith('u1', 'only');
    expect(sentProps(runOurs)).toEqual({ to: 'me@e2e.local' });
  });

  it('fails a step that runs as no account before the action runs', async () => {
    const { router, runOurs } = build({});
    await expect(
      router.runAction(send({ to: '{{$account.email}}' }, { auth: undefined, stepName: 'Mail me' })),
    ).rejects.toThrow('Step "Mail me" has no gmail account to run as — connect one');
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('refuses an unknown type before asking the provider or storing an account', async () => {
    const { router, runOurs, accountOf, recordAccount } = build({
      'u1:c1': { provider: 'slack', account: null, checkedAt: null },
    });
    const failure = router.runAction(
      send({ text: '{{$account.name}}' }, { actionId: 'slack.no_such_thing' }),
    );
    await expect(failure).rejects.toThrow(
      'No installed rail can run "slack.no_such_thing" — it is neither an SDK action nor in the managed (Composio) catalog',
    );
    await expect(failure).rejects.toMatchObject({ status: 400 });
    expect(runOurs).not.toHaveBeenCalled();
    expect(accountOf).not.toHaveBeenCalled();
    expect(recordAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['no account', undefined],
    ["someone else's account", { connectionId: 'c-theirs' }],
    ["the runner's own account", { connectionId: 'c1' }],
  ])('fails a step whose action needs no account, holding %s, without reading one', async (_held, auth) => {
    const { router, runOurs, accountOf } = build({
      'u1:c1': { provider: 'gmail', account: MAILBOX, checkedAt: new Date() },
    });
    await expect(
      router.runAction(
        send(
          { texts: ['to:', '{{$account.email}}'] },
          { actionId: 'text.concat', stepName: 'Join text', auth },
        ),
      ),
    ).rejects.toThrow(
      'Step "Join text" uses no account, so {{$account.email}} has no value — it is filled only on a step that runs as one',
    );
    expect(accountOf).not.toHaveBeenCalled();
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('hands a step whose action needs no account none of the account stored on it', async () => {
    const { router, runOurs } = build({});
    await router.runAction(
      send({ texts: ['a'] }, { actionId: 'text.concat', auth: { connectionId: 'c-theirs' } }),
    );
    expect((runOurs.mock.calls[0]?.[0] as RunActionInput).auth).toBeUndefined();
  });

  it('touches nothing when a step has no account reference', async () => {
    const { router, accountOf } = build({});
    await router.runAction(send({ to: 'someone@e2e.local' }));
    expect(accountOf).not.toHaveBeenCalled();
  });
});
