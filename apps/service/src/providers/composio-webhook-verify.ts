import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Composio webhook verification (ADR 0046) — the `/api/hooks/composio` trust boundary, implementing the Svix scheme:
 * HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<rawBody>`, base64, against possibly SEVERAL space-separated
 * `v1,<sig>` values during rotation. The secret is used as a RAW utf-8 string (never base64-decoded). Never throws.
 */
export interface ComposioWebhookVerifyResult {
  ok: boolean;
  /** Why verification failed (logged, never returned to the caller) — undefined on success. */
  reason?: string;
}

/** Replay window in seconds (matches the Composio SDK); `0` disables the check. */
const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyComposioWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): ComposioWebhookVerifyResult {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing webhook-id/webhook-timestamp/webhook-signature header' };
  }

  if (toleranceSeconds > 0) {
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return { ok: false, reason: 'unparseable webhook-timestamp' };
    const skew = Math.abs(Date.now() / 1000 - sent);
    if (skew > toleranceSeconds) {
      return { ok: false, reason: `timestamp outside ${toleranceSeconds}s tolerance` };
    }
  }

  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  for (const part of signatureHeader.split(' ')) {
    if (!part) continue;
    const comma = part.indexOf(',');
    const version = comma >= 0 ? part.slice(0, comma) : '';
    const value = comma >= 0 ? part.slice(comma + 1) : part;
    if (version === 'v1' && value && timingSafeEqualStr(value, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no matching v1 signature' };
}

/** Constant-time compare of two base64 signature strings (length-guarded — different lengths never match). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
