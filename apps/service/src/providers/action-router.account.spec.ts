import type { ConfigService } from '@nestjs/config';

import type { AccountIdentity } from '../connections/account-identity';
import type { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import type { ConnectionsService, StoredAccount } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
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

function build(stored: Record<string, StoredAccount>, slot?: { id: string; ownerUserId: string }) {
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
      has: (type: string) => type.startsWith('gmail.') || type.startsWith('slack.'),
      runAction: runOurs,
    } as unknown as SdkActionsProvider,
    { isConfigured: () => Promise.resolve(false) } as unknown as ComposioExecutionProvider,
    {
      managedRef: () => Promise.resolve(null),
      resolveSlotConnection: () => Promise.resolve(slot ?? null),
      resolveClusterConnection: () => Promise.resolve(null),
      accountOf,
      recordAccount,
    } as unknown as ConnectionsService,
    { get: () => ({ composioFallbackApps: '' }) } as unknown as ConfigService<{ env: EnvConfig }, true>,
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
    await expect(router.runAction(send({ to: ref }))).rejects.toThrow(message);
    expect(sentProps(runOurs)).toBeUndefined();
  });

  it('fails a step that runs as no connection', async () => {
    const { router, runOurs } = build({});
    await expect(router.runAction(send({ to: '{{$account.email}}' }, { auth: undefined }))).rejects.toThrow(
      'this step runs as none',
    );
    expect(runOurs).not.toHaveBeenCalled();
  });

  it('touches nothing when a step has no account reference', async () => {
    const { router, accountOf } = build({});
    await router.runAction(send({ to: 'someone@e2e.local' }));
    expect(accountOf).not.toHaveBeenCalled();
  });
});
