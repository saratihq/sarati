import type { RegisteredWebhook } from '../registered-webhook';
import { WebhookDeleteFence } from './webhook-delete-fence';

const typeform = (tag: string): RegisteredWebhook => ({
  triggerType: 'typeform.new_response',
  props: { formId: 'F1' },
  connection: { connectionId: 'c1', ownerUserId: 'u1' },
  webhookUrl: `https://x/api/hooks/${tag}/production`,
  secret: 'ours',
  registration: { subscriptionId: tag, formId: 'F1' },
});

function gate(): { open: () => void; opened: Promise<void> } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('retried webhook deletes beside stand-ups', () => {
  it('a stand-up handed the handle of a delete in flight registers again once the delete has landed', async () => {
    const fence = new WebhookDeleteFence();
    const deleteHeld = gate();
    const deleting = fence.deleting(typeform('t1'), () => deleteHeld.opened);
    let registrations = 0;
    let standingUp = true;
    const standUp = fence
      .standUp(() => {
        registrations += 1;
        return Promise.resolve(typeform('t1'));
      })
      .then(() => (standingUp = false));

    await tick();
    expect(registrations).toBe(1);
    expect(standingUp).toBe(true);

    deleteHeld.open();
    await Promise.all([deleting, standUp]);
    expect(registrations).toBe(2);
  });

  it('a stand-up during which a delete of its handle finished registers again', async () => {
    const fence = new WebhookDeleteFence();
    let registrations = 0;
    await fence.standUp(async () => {
      registrations += 1;
      if (registrations === 1) await fence.deleting(typeform('t1'), () => Promise.resolve());
      return typeform('t1');
    });

    expect(registrations).toBe(2);
  });

  it('a stand-up whose handle no delete touches registers once and never waits', async () => {
    const fence = new WebhookDeleteFence();
    const deleteHeld = gate();
    const deleting = fence.deleting(typeform('other'), () => deleteHeld.opened);
    let registrations = 0;
    await fence.standUp(() => {
      registrations += 1;
      return Promise.resolve(typeform('t1'));
    });

    expect(registrations).toBe(1);
    deleteHeld.open();
    await deleting;
  });

  it('a delete that starts after a stand-up returned is not waited on', async () => {
    const fence = new WebhookDeleteFence();
    let registrations = 0;
    await fence.standUp(() => {
      registrations += 1;
      return Promise.resolve(typeform('t1'));
    });
    const deleteHeld = gate();
    const deleting = fence.deleting(typeform('t1'), () => deleteHeld.opened);

    expect(registrations).toBe(1);
    deleteHeld.open();
    await deleting;
  });

  it('a stand-up the app answers with no handle registers once', async () => {
    const fence = new WebhookDeleteFence();
    const deleteHeld = gate();
    const deleting = fence.deleting(typeform('t1'), () => deleteHeld.opened);
    const register = jest.fn(() => Promise.resolve(null));

    await fence.standUp(register);

    expect(register).toHaveBeenCalledTimes(1);
    deleteHeld.open();
    await deleting;
  });

  it('a failed delete and a failed stand-up both leave the fence clear', async () => {
    const fence = new WebhookDeleteFence();
    await expect(fence.deleting(typeform('t1'), () => Promise.reject(new Error('HTTP 500')))).rejects.toThrow(
      'HTTP 500',
    );
    await expect(fence.standUp(() => Promise.reject(new Error('HTTP 503')))).rejects.toThrow('HTTP 503');
    const register = jest.fn(() => Promise.resolve(typeform('t1')));

    await fence.standUp(register);

    expect(register).toHaveBeenCalledTimes(1);
  });
});
