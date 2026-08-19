import type { ActionRouterProvider } from './action-router.provider';
import { ConnectionIdentityService } from './connection-identity.service';

/** Every response below was captured from a live connection through the managed rail. */
const routerReturning = (output: unknown): ActionRouterProvider =>
  ({ runAction: () => Promise.resolve({ output }) }) as unknown as ActionRouterProvider;

describe('which account a connection is authorized against', () => {
  it('names the Slack workspace and its team id — the pair that settles a wrong-workspace argument', async () => {
    const identity = new ConnectionIdentityService(
      routerReturning({ team: { id: 'T0BFMNPDEQ2', name: 'orchestr' } }),
    );
    await expect(identity.probe('u', 'c', 'slack')).resolves.toEqual({
      name: 'orchestr',
      id: 'T0BFMNPDEQ2',
    });
  });

  it("reads GitHub's login and numeric id", async () => {
    const identity = new ConnectionIdentityService(routerReturning({ login: 'eghuzefa', id: 190477365 }));
    await expect(identity.probe('u', 'c', 'github')).resolves.toEqual({
      name: 'eghuzefa',
      id: '190477365',
    });
  });

  it('names the Google account behind a Sheets connection', async () => {
    const identity = new ConnectionIdentityService(
      routerReturning({
        user: {
          displayName: 'A Name',
          emailAddress: 'huzefa@sarati.io',
          permissionId: '0884870653855901152',
        },
      }),
    );
    await expect(identity.probe('u', 'c', 'sheets')).resolves.toEqual({
      name: 'huzefa@sarati.io',
      id: '0884870653855901152',
    });
  });

  it('says nothing for an app it cannot ask, rather than implying there is no account', async () => {
    const identity = new ConnectionIdentityService(routerReturning({ anything: true }));
    expect(identity.canProbe('claude')).toBe(false);
    await expect(identity.probe('u', 'c', 'claude')).resolves.toBeNull();
  });

  it('never fails a caller when the provider refuses', async () => {
    const identity = new ConnectionIdentityService({
      runAction: () => Promise.reject(new Error('token expired')),
    } as unknown as ActionRouterProvider);
    await expect(identity.probe('u', 'c', 'slack')).resolves.toBeNull();
  });

  it('returns null rather than half an answer when the response names nothing', async () => {
    const identity = new ConnectionIdentityService(routerReturning({ ok: true }));
    await expect(identity.probe('u', 'c', 'slack')).resolves.toBeNull();
  });
});
