import type { AccountIdentity } from '../connections/account-identity';
import type { ActivatedConnection, ConnectionsService, StoredAccount } from '../connections/connections.service';
import type { AccountTarget } from './account-probes';
import type { ActionRouterProvider } from './action-router.provider';
import { ConnectionIdentityService } from './connection-identity.service';

const MAILBOX: AccountIdentity = {
  subject: 'user',
  name: null,
  id: 'me@e2e.local',
  email: 'me@e2e.local',
  handle: null,
};
const TARGET: AccountTarget = { connectionId: 'c1', ownerUserId: 'u1', provider: 'gmail', orgId: null };

function build(stored: StoredAccount | null, refresh: () => Promise<AccountIdentity | null>) {
  const refreshAccount = jest.fn(refresh);
  let listener: ((connection: ActivatedConnection) => Promise<void>) | undefined;
  const connections = {
    accountOf: jest.fn(() => Promise.resolve(stored)),
    onActivated: (fn: (connection: ActivatedConnection) => Promise<void>) => {
      listener = fn;
    },
  } as unknown as ConnectionsService;
  const identity = new ConnectionIdentityService(
    { refreshAccount } as unknown as ActionRouterProvider,
    connections,
  );
  identity.onModuleInit();
  return { identity, refreshAccount, activate: (c: ActivatedConnection) => listener!(c) };
}

describe('ConnectionIdentityService', () => {
  it('answers from what the provider last said, without asking again', async () => {
    const { identity, refreshAccount } = build(
      { provider: 'gmail', account: MAILBOX, checkedAt: new Date() },
      () => Promise.resolve(null),
    );
    await expect(identity.account(TARGET, false)).resolves.toEqual(MAILBOX);
    expect(refreshAccount).not.toHaveBeenCalled();
  });

  it('asks when the provider never has been, and again on refresh', async () => {
    const { identity, refreshAccount } = build({ provider: 'gmail', account: null, checkedAt: null }, () =>
      Promise.resolve(MAILBOX),
    );
    await expect(identity.account(TARGET, false)).resolves.toEqual(MAILBOX);
    await expect(identity.account(TARGET, true)).resolves.toEqual(MAILBOX);
    expect(refreshAccount).toHaveBeenCalledTimes(2);
  });

  it('asks once for one connection however many callers wait on it', async () => {
    let answer: (identity: AccountIdentity) => void = () => undefined;
    const { identity, refreshAccount } = build(
      null,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = identity.account(TARGET, true);
    const second = identity.account(TARGET, true);
    answer(MAILBOX);
    await expect(Promise.all([first, second])).resolves.toEqual([MAILBOX, MAILBOX]);
    expect(refreshAccount).toHaveBeenCalledTimes(1);
  });

  it('never fails a caller when the provider refuses', async () => {
    const { identity } = build(null, () => Promise.reject(new Error('token expired')));
    await expect(identity.account(TARGET, true)).resolves.toBeNull();
  });

  it('asks as soon as a connection becomes usable, and not for an app it cannot ask', async () => {
    const { activate, refreshAccount } = build(null, () => Promise.resolve(MAILBOX));
    await activate({ id: 'c1', ownerUserId: 'u1', provider: 'gmail', orgId: 'o1' });
    expect(refreshAccount).toHaveBeenCalledWith({
      connectionId: 'c1',
      ownerUserId: 'u1',
      provider: 'gmail',
      orgId: 'o1',
    });
    await activate({ id: 'c2', ownerUserId: 'u1', provider: 'claude', orgId: null });
    expect(refreshAccount).toHaveBeenCalledTimes(1);
  });
});
