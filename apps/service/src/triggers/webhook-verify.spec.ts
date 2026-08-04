import { createHmac } from 'node:crypto';

import { verifyWebhookSignature } from './webhook-verify';

const SECRET = 'shhh-signing-secret';
const BODY = JSON.stringify({ event: 'push', id: 42 });

describe('verifyWebhookSignature', () => {
  it('github preset: accepts a valid sha256=<hex> and rejects a forgery', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSignature({ preset: 'github' }, BODY, { 'x-hub-signature-256': sig }, SECRET)).toBe(
      true,
    );
    // wrong body
    expect(verifyWebhookSignature({ preset: 'github' }, '{}', { 'x-hub-signature-256': sig }, SECRET)).toBe(
      false,
    );
    // wrong secret
    expect(verifyWebhookSignature({ preset: 'github' }, BODY, { 'x-hub-signature-256': sig }, 'nope')).toBe(
      false,
    );
    // missing header
    expect(verifyWebhookSignature({ preset: 'github' }, BODY, {}, SECRET)).toBe(false);
  });

  it('shopify preset: accepts a valid base64 HMAC', () => {
    const sig = createHmac('sha256', SECRET).update(BODY).digest('base64');
    expect(
      verifyWebhookSignature({ preset: 'shopify' }, BODY, { 'x-shopify-hmac-sha256': sig }, SECRET),
    ).toBe(true);
    expect(
      verifyWebhookSignature({ preset: 'shopify' }, BODY, { 'x-shopify-hmac-sha256': 'AAAA' }, SECRET),
    ).toBe(false);
  });

  it('stripe preset: verifies v1 over `${t}.${body}` and rejects tampering', () => {
    const t = '1700000000';
    const v1 = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex');
    const header = `t=${t},v1=${v1}`;
    expect(verifyWebhookSignature({ preset: 'stripe' }, BODY, { 'stripe-signature': header }, SECRET)).toBe(
      true,
    );
    // a v1 that signs the body WITHOUT the timestamp must fail
    const wrong = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(
      verifyWebhookSignature(
        { preset: 'stripe' },
        BODY,
        { 'stripe-signature': `t=${t},v1=${wrong}` },
        SECRET,
      ),
    ).toBe(false);
  });

  it('generic: honours a custom header/algo/format/prefix', () => {
    const sig = createHmac('sha1', SECRET).update(BODY).digest('hex');
    const cfg = {
      preset: 'generic' as const,
      algo: 'sha1' as const,
      header: 'x-sig',
      format: 'hex' as const,
    };
    expect(verifyWebhookSignature(cfg, BODY, { 'x-sig': sig }, SECRET)).toBe(true);
    expect(verifyWebhookSignature(cfg, BODY, { 'x-sig': sig }, 'other')).toBe(false);
  });
});
