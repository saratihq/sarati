import { legacyRegistrationOf, registeredWebhookOf, webhookRegistrationOf } from './registered-webhook';

describe('the stored webhook registration', () => {
  const registration = { subscriptionId: 'we_1', signingSecret: 'whsec_1' };
  const record = {
    triggerType: 'stripe.new_customer',
    props: {},
    connection: { connectionId: 'c1', ownerUserId: 'u1' },
    webhookUrl: 'https://x/api/hooks/w/production',
    secret: 'ours',
    registration,
  };

  it('reads the record this release stores', () => {
    expect(registeredWebhookOf(record)).toEqual(record);
    expect(legacyRegistrationOf(record)).toBeNull();
    expect(webhookRegistrationOf(record)).toEqual(registration);
  });

  it('reads the bare handle an earlier release stored, which names no trigger', () => {
    expect(registeredWebhookOf(registration)).toBeNull();
    expect(legacyRegistrationOf(registration)).toEqual(registration);
    expect(webhookRegistrationOf(registration)).toEqual(registration);
  });

  it.each([null, 'we_1', [], {}, { registration }])('finds no handle in %p', (stored) => {
    expect(registeredWebhookOf(stored)).toBeNull();
    expect(webhookRegistrationOf(stored)).toBeNull();
  });
});
