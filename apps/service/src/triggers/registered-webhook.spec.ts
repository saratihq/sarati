import {
  legacyRegistrationOf,
  registeredWebhookOf,
  sameRegistration,
  webhookRegistrationOf,
} from './registered-webhook';

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

describe('whether two handles name the same registration', () => {
  const typeform = (subscriptionId: string, formId: string, triggerType = 'typeform.new_response') => ({
    triggerType,
    registration: { subscriptionId, formId },
  });

  it('is the same Typeform webhook when the tag and form match, whatever account or secret registered it', () => {
    expect(sameRegistration(typeform('orchestr-1', 'F1'), typeform('orchestr-1', 'F1'))).toBe(true);
    const minted = {
      triggerType: 'stripe.new_customer',
      registration: { subscriptionId: 'we_1', signingSecret: 'a' },
    };
    const reminted = {
      triggerType: 'stripe.payment_succeeded',
      registration: { subscriptionId: 'we_1', signingSecret: 'b' },
    };
    expect(sameRegistration(minted, reminted)).toBe(true);
  });

  it.each([
    ['another form', typeform('orchestr-1', 'F2')],
    ['another tag', typeform('orchestr-2', 'F1')],
    ['another app', typeform('orchestr-1', 'F1', 'github.new_push')],
  ])('is a different webhook on %s', (_case, other) => {
    expect(sameRegistration(typeform('orchestr-1', 'F1'), other)).toBe(false);
  });
});
