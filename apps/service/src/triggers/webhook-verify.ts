import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Native inbound-webhook signature verification (ADR 0030). The non-secret config lives on the
 * trigger params (diffable, in the version doc); the signing SECRET is stored out-of-doc, env-scoped.
 */

export type WebhookVerifyPreset = 'github' | 'shopify' | 'stripe' | 'generic';

/** Non-secret verification config carried on the trigger node's params. */
export interface WebhookVerification {
  preset?: WebhookVerifyPreset;
  /** generic only: HMAC algorithm. */
  algo?: 'sha1' | 'sha256';
  /** generic only: the header carrying the signature. */
  header?: string;
  /** generic only: how the digest is encoded. */
  format?: 'hex' | 'base64';
  /** generic only: a literal prefix on the header value (e.g. "sha256="). */
  prefix?: string;
}

interface ResolvedScheme {
  algo: 'sha1' | 'sha256';
  header: string;
  format: 'hex' | 'base64';
  prefix: string;
}

const PRESETS: Record<Exclude<WebhookVerifyPreset, 'stripe' | 'generic'>, ResolvedScheme> = {
  github: { algo: 'sha256', header: 'x-hub-signature-256', format: 'hex', prefix: 'sha256=' },
  shopify: { algo: 'sha256', header: 'x-shopify-hmac-sha256', format: 'base64', prefix: '' },
};

/** Resolve the config to a concrete scheme (generic falls back to sane defaults). */
function resolveScheme(cfg: WebhookVerification): ResolvedScheme {
  if (cfg.preset && cfg.preset !== 'stripe' && cfg.preset !== 'generic') return PRESETS[cfg.preset];
  return {
    algo: cfg.algo ?? 'sha256',
    header: (cfg.header ?? 'x-signature').toLowerCase(),
    format: cfg.format ?? 'hex',
    prefix: cfg.prefix ?? '',
  };
}

/** Constant-time equality over two UTF-8 strings (length-safe). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True iff the delivery's signature is valid for `secret`. `headers` MUST be a lower-cased
 * single-value map and `rawBody` the exact received bytes.
 */
export function verifyWebhookSignature(
  cfg: WebhookVerification,
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): boolean {
  if (cfg.preset === 'stripe') return verifyStripe(rawBody, headers, secret);

  const scheme = resolveScheme(cfg);
  const provided = headers[scheme.header];
  if (!provided) return false;
  const expected = scheme.prefix + createHmac(scheme.algo, secret).update(rawBody).digest(scheme.format);
  return safeEqual(provided, expected);
}

/** Stripe: `stripe-signature: t=<ts>,v1=<hexHmacSha256 of `${t}.${rawBody}`>`. */
function verifyStripe(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const raw = headers['stripe-signature'];
  if (!raw) return false;
  let t = '';
  const v1: string[] = [];
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v) t = v;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || v1.length === 0) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  // Any of the provided v1 signatures matching is accepted (Stripe may send several).
  return v1.some((sig) => safeEqual(sig, expected));
}
