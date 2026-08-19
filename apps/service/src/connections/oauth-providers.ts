import { Injectable } from '@nestjs/common';
import { guardUserUrl, ssrfAllowedHostsFromEnv } from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import { asBool } from '../config/env.config';

/** A resolved OAuth2 app — catalog endpoint metadata + env client credentials. */
export interface OAuthProviderConfig {
  provider: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Must match the provider's registered value and be sent identically in the authorize AND token requests. */
  redirectUri: string;
  /** PKCE (S256) — on by default; the secure OAuth2.1 default. */
  usePkce: boolean;
  /** Extra authorize-URL params (e.g. Google's `access_type=offline`). */
  authExtraParams: Record<string, string>;
}

/**
 * Non-secret endpoint metadata for well-known providers, so an operator supplies only `OAUTH_<PROVIDER>_CLIENT_ID/SECRET`.
 * An unlisted provider still works by also supplying `OAUTH_<PROVIDER>_AUTH_URL/TOKEN_URL`.
 */
interface CatalogEntry {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  authExtraParams?: Record<string, string>;
}
const CATALOG: Record<string, CatalogEntry> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    // Required for Google to return a refresh_token (and to re-consent for it).
    authExtraParams: { access_type: 'offline', prompt: 'consent' },
  },
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['chat:write'],
  },
};

/** The registry of CONFIGURED providers — those with both a client id and secret; env overrides the catalog per key. */
export function loadOAuthProviders(
  env: Record<string, string | undefined>,
  redirectUri: string,
): Map<string, OAuthProviderConfig> {
  const registry = new Map<string, OAuthProviderConfig>();

  // The catalog plus any provider an `OAUTH_<PROVIDER>_CLIENT_ID` env var names (fully custom ones).
  const names = new Set<string>(Object.keys(CATALOG));
  for (const key of Object.keys(env)) {
    const m = /^OAUTH_([A-Z0-9]+)_CLIENT_ID$/.exec(key);
    if (m?.[1]) names.add(m[1].toLowerCase());
  }

  for (const name of names) {
    const upper = name.toUpperCase();
    const clientId = env[`OAUTH_${upper}_CLIENT_ID`];
    const clientSecret = env[`OAUTH_${upper}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue; // not configured — skip

    const catalog = CATALOG[name];
    const authUrl = env[`OAUTH_${upper}_AUTH_URL`] || catalog?.authUrl;
    const tokenUrl = env[`OAUTH_${upper}_TOKEN_URL`] || catalog?.tokenUrl;
    if (!authUrl || !tokenUrl) continue; // unknown provider without explicit endpoints

    const scopesRaw = env[`OAUTH_${upper}_SCOPES`];
    const scopes = scopesRaw ? scopesRaw.split(/[\s,]+/).filter(Boolean) : (catalog?.scopes ?? []);

    registry.set(name, {
      provider: name,
      authUrl,
      tokenUrl,
      clientId,
      clientSecret,
      scopes,
      redirectUri,
      usePkce: asBool(env[`OAUTH_${upper}_PKCE`], true),
      authExtraParams: catalog?.authExtraParams ?? {},
    });
  }
  return registry;
}

/** Public (secret-free) view of a configured provider, for the FE's connect UI. */
export interface OAuthProviderSummary {
  provider: string;
  scopes: string[];
}

/** A user-supplied ("bring your own") OAuth client — stored Fernet-encrypted and never returned. */
export interface ByoOAuthClient {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  usePkce: boolean;
}

/** Validate + narrow a decrypted stored BYO client; a corrupt/rotated blob degrades to null, never throws into a run. */
export function parseByoClient(json: string): ByoOAuthClient | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.clientId !== 'string' || typeof o.clientSecret !== 'string') return null;
  if (typeof o.authUrl !== 'string' || typeof o.tokenUrl !== 'string') return null;
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === 'string') : [];
  return {
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    authUrl: o.authUrl,
    tokenUrl: o.tokenUrl,
    scopes,
    usePkce: o.usePkce !== false, // default on (OAuth2.1)
  };
}

/** Build the standard {@link OAuthProviderConfig} from a BYO client so the existing
 *  authorize/exchange/refresh code runs against it unchanged. */
export function byoClientToConfig(
  provider: string,
  byo: ByoOAuthClient,
  redirectUri: string,
): OAuthProviderConfig {
  return {
    provider,
    authUrl: byo.authUrl,
    tokenUrl: byo.tokenUrl,
    clientId: byo.clientId,
    clientSecret: byo.clientSecret,
    scopes: byo.scopes,
    redirectUri,
    usePkce: byo.usePkce,
    authExtraParams: {},
  };
}

/**
 * STORE-TIME https + SSRF guard for a BYO OAuth endpoint, throwing {@link DomainError}(400). It runs at
 * input because the `auth_url` is only ever a browser redirect, so this is its ONLY guard;
 * ORCHESTR_HTTP_ALLOWED_HOSTS opts a host back in (and lifts https for it).
 */
export async function assertSafeOAuthEndpoint(label: string, rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError(`OAuth ${label} is not a valid URL`, 400);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // unbracket v6 literals
  const allowlisted = ssrfAllowedHostsFromEnv().includes(host);
  if (url.protocol !== 'https:' && !allowlisted) {
    throw new DomainError(`OAuth ${label} must use https (got ${url.protocol || 'no scheme'})`, 400);
  }
  try {
    // The SDK's shared SSRF guard — blocks a private/loopback/link-local/cloud-metadata target.
    await guardUserUrl(rawUrl);
  } catch {
    throw new DomainError(`OAuth ${label} must not point at a private or internal address`, 400);
  }
}

@Injectable()
export class OAuthProvidersService {
  constructor(
    private readonly registry: Map<string, OAuthProviderConfig>,
    /** The app's OAuth callback URL — shared by env providers AND BYO clients. */
    readonly redirectUri: string = '',
  ) {}

  get(provider: string): OAuthProviderConfig | null {
    return this.registry.get(provider) ?? null;
  }

  list(): OAuthProviderSummary[] {
    return [...this.registry.values()].map((c) => ({ provider: c.provider, scopes: c.scopes }));
  }
}
