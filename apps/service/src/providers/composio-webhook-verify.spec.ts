import { createHmac } from 'node:crypto';

import { verifyComposioWebhook } from './composio-webhook-verify';

/** The Composio webhook signature verifier (ADR 0046) — the `/api/hooks/composio` trust boundary. */
describe('verifyComposioWebhook', () => {
  const secret = 'whsec_test_raw_secret_value';
  const id = 'msg_2abc';
  const rawBody = JSON.stringify({ type: 'composio.trigger.message', metadata: { trigger_id: 'ti_x' } });

  const sign = (webhookId: string, timestamp: string, body: string, key: string): string =>
    'v1,' + createHmac('sha256', key).update(`${webhookId}.${timestamp}.${body}`).digest('base64');

  const nowTs = (): string => String(Math.floor(Date.now() / 1000));

  const headers = (overrides: Record<string, string> = {}): Record<string, string> => {
    const ts = overrides['webhook-timestamp'] ?? nowTs();
    return {
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': sign(id, ts, rawBody, secret),
      ...overrides,
    };
  };

  it('accepts a correctly-signed delivery', () => {
    expect(verifyComposioWebhook(rawBody, headers(), secret)).toEqual({ ok: true });
  });

  it('rejects a signature made with the wrong secret', () => {
    const ts = nowTs();
    const forged = { 'webhook-signature': sign(id, ts, rawBody, 'wrong-secret'), 'webhook-timestamp': ts };
    const res = verifyComposioWebhook(rawBody, headers(forged), secret);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no matching v1 signature');
  });

  it('rejects a tampered body against a good signature', () => {
    const res = verifyComposioWebhook(rawBody + ' tampered', headers(), secret);
    expect(res.ok).toBe(false);
  });

  it('accepts when the header carries multiple space-separated signatures and ONE matches', () => {
    const ts = nowTs();
    const good = sign(id, ts, rawBody, secret);
    const stale = sign(id, ts, rawBody, 'old-rotated-secret');
    const multi = headers({ 'webhook-timestamp': ts, 'webhook-signature': `${stale} ${good}` });
    expect(verifyComposioWebhook(rawBody, multi, secret)).toEqual({ ok: true });
  });

  it('rejects a stale timestamp outside the tolerance window (replay guard)', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10_000);
    const res = verifyComposioWebhook(rawBody, headers({ 'webhook-timestamp': stale }), secret);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('tolerance');
  });

  it('accepts a stale timestamp when tolerance is disabled (0)', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10_000);
    expect(verifyComposioWebhook(rawBody, headers({ 'webhook-timestamp': stale }), secret, 0).ok).toBe(true);
  });

  it('rejects when a required header is missing', () => {
    const h = headers();
    delete h['webhook-signature'];
    expect(verifyComposioWebhook(rawBody, h, secret).ok).toBe(false);
  });

  it('fails CLOSED when no secret is configured', () => {
    const res = verifyComposioWebhook(rawBody, headers(), '');
    expect(res).toEqual({ ok: false, reason: 'no webhook secret configured' });
  });
});
