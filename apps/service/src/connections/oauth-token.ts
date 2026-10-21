import { ActionError, type FetchLikeResponse, guardedFetch, redactSecrets } from '@sarati/actions-sdk';

import { isRecord } from '../common/json-util';

import type { OAuthProviderConfig } from './oauth-providers';
import { redirectLocation } from './redirect-location';

/** The token set a provider returns from an authorization_code (or refresh) grant. */
export interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  /** Seconds until the access token expires (provider-reported). */
  expires_in?: number;
  token_type?: string;
  scope?: string;
  /** The full decoded response, for provider-specific fields we don't model. */
  raw: Record<string, unknown>;
}

/** Thrown only when the provider refused the grant itself (RFC 6749 §5.2) or answered it without an access token. */
export class OAuthExchangeError extends Error {}

const TOKEN_TIMEOUT_MS = 30_000;
const REFUSED_GRANT = new Set([400, 401, 403]);
const TRY_LATER = new Set([408, 429]);

// What the provider said, never the raw body: it can hold tokens nested where we do not look.
function summary(text: string, data: unknown): string {
  return redactSecrets(providerSaid(text, data).slice(0, 200)) || '(empty body)';
}

function providerSaid(text: string, data: unknown): string {
  if (!isRecord(data)) return text.trim();
  const said = [data.error, data.error_description].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return said.length > 0
    ? said.join(': ')
    : `a reply with fields ${Object.keys(data).join(', ') || '(none)'}`;
}

// A token endpoint that never answered, or broke off, did not refuse anything: never an OAuthExchangeError.
function unanswered(origin: string, err: unknown, reading: boolean): ActionError {
  if (err instanceof ActionError) return err;
  const { name, cause } = (err ?? {}) as { name?: unknown; cause?: unknown };
  if (name === 'TimeoutError') {
    return new ActionError({
      code: 'transport_timeout',
      message: `the token endpoint ${origin} did not answer within ${TOKEN_TIMEOUT_MS / 1000}s`,
      retryable: true,
      cause: err,
    });
  }
  const reason = String(
    (cause as { message?: unknown } | undefined)?.message ?? (err as { message?: unknown }).message ?? err,
  );
  return new ActionError({
    code: 'transport_interrupted',
    message: `the connection to ${origin} broke ${reading ? 'while reading the token response' : 'during the token request'}: ${reason}`,
    retryable: true,
    cause: err,
  });
}

/**
 * POST an OAuth2 grant as form-urlencoded with client credentials in the body. Throws `OAuthExchangeError` only when
 * the provider refused the grant; anything else (a redirect, an outage, a broken connection) is an `ActionError`.
 */
async function postToken(tokenUrl: string, params: Record<string, string>): Promise<OAuthTokenSet> {
  const origin = new URL(tokenUrl).origin;
  let res: FetchLikeResponse;
  try {
    // `tokenUrl` may be a user-supplied BYO endpoint, so both grants ride the SDK's SSRF-guarded hop and never follow a redirect.
    res = await guardedFetch(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err) {
    throw unanswered(origin, err, false);
  }
  if (res.status >= 300 && res.status < 400) {
    const target = redirectLocation(res, tokenUrl);
    throw new ActionError({
      code: 'http_error',
      message: target
        ? `the token endpoint ${origin} redirected (${res.status}) to ${target}; use that URL as the token URL, since a token endpoint must answer directly`
        : `the token endpoint ${origin} redirected (${res.status}) without saying where; a token endpoint must answer directly`,
      retryable: false,
      status: res.status,
    });
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw unanswered(origin, err, true);
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (REFUSED_GRANT.has(res.status)) {
    throw new OAuthExchangeError(`Token endpoint refused the grant (${res.status}): ${summary(text, data)}`);
  }
  if (res.status >= 500 || TRY_LATER.has(res.status)) {
    throw new ActionError({
      code: 'provider_error',
      message: `the token endpoint ${origin} answered ${res.status}: ${summary(text, data)}`,
      retryable: true,
      status: res.status,
    });
  }
  if (res.status >= 400) {
    throw new ActionError({
      code: 'http_error',
      message: `the token endpoint ${origin} answered ${res.status}: ${summary(text, data)}; check the token URL`,
      retryable: false,
      status: res.status,
    });
  }
  if (!isRecord(data) || typeof data.access_token !== 'string' || !data.access_token) {
    // e.g. Slack returns 200 with { ok: false, error: '...' }.
    throw new OAuthExchangeError(`Token endpoint returned no access_token: ${summary(text, data)}`);
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    token_type: typeof data.token_type === 'string' ? data.token_type : undefined,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    raw: data,
  };
}

/** Exchange an authorization code (with the PKCE verifier, if used) for tokens. */
export function exchangeAuthorizationCode(
  cfg: OAuthProviderConfig,
  code: string,
  codeVerifier: string | null,
): Promise<OAuthTokenSet> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  };
  if (cfg.usePkce && codeVerifier) params.code_verifier = codeVerifier;
  return postToken(cfg.tokenUrl, params);
}

/** Redeem a refresh token for a fresh access token (grant_type=refresh_token). */
export function refreshAccessToken(cfg: OAuthProviderConfig, refreshToken: string): Promise<OAuthTokenSet> {
  return postToken(cfg.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
}
