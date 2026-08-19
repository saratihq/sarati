import { guardUserUrl } from '@sarati/actions-sdk';
import { request } from 'undici';

import { isRecord } from '../common/json-util';

import type { OAuthProviderConfig } from './oauth-providers';

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

/** Thrown when the token endpoint rejects the grant or returns no access token. */
export class OAuthExchangeError extends Error {}

/**
 * POST an OAuth2 grant as form-urlencoded with client credentials in the body, returning the parsed token set
 * or throwing `OAuthExchangeError` with the upstream detail.
 */
async function postToken(tokenUrl: string, params: Record<string, string>): Promise<OAuthTokenSet> {
  // The SSRF choke point for BOTH grants — `tokenUrl` may be a fully user-supplied BYO endpoint.
  await guardUserUrl(tokenUrl);
  const body = new URLSearchParams(params).toString();
  const res = await request(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
  const text = await res.body.text().catch(() => '');
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (res.statusCode >= 400) {
    const detail = isRecord(data) ? JSON.stringify(data) : text;
    throw new OAuthExchangeError(`Token endpoint returned ${res.statusCode}: ${detail}`);
  }
  if (!isRecord(data) || typeof data.access_token !== 'string' || !data.access_token) {
    // e.g. Slack returns 200 with { ok: false, error: '...' }.
    throw new OAuthExchangeError(`Token endpoint returned no access_token: ${text || '(empty body)'}`);
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
