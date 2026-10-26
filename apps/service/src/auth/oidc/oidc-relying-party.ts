import { timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redactSecrets } from '@sarati/actions-sdk';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { request } from 'undici';

import { errorMessage } from '../../common/error-message';
import { isRecord } from '../../common/json-util';
import { pkceChallenge } from '../../common/pkce';
import { isLoopbackHost, type EnvConfig } from '../../config/env.config';

/** Where the identity provider sends the browser back; every operator registers it at their IdP, so renaming it breaks sign-in everywhere. */
export const OIDC_CALLBACK_PATH = '/auth/oidc/callback';

const DISCOVERY_TTL_MS = 60 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const ID_TOKEN_ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_ID_TOKEN_AGE = '10m';
const SCOPE = 'openid email profile';

/** The provider could not be reached or answered with something unusable — the operator log names which. */
export class OidcUnavailableError extends Error {}

/** The provider refused the grant, or its answer failed verification — the operator log names which check. */
export class OidcRejectedError extends Error {}

/** What the provider's discovery document says, checked. */
export interface OidcDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  algorithms: string[];
  clientAuth: 'client_secret_basic' | 'client_secret_post';
  /** RFC 9207: the provider names itself in every authorization response. */
  issParameter: boolean;
}

/** A discovery document with the provider's keys behind its jwks_uri. */
export type LoadedDiscovery = OidcDiscovery & { keys: Jwks };

/** Who the provider vouched for, from a verified ID token and, when it held back the email, the UserInfo endpoint. */
export interface IdpClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  preferredUsername: string | null;
}

interface Answer {
  status: number;
  json: unknown;
}

type Jwks = ReturnType<typeof createRemoteJWKSet>;

function where(url: string): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}

function formEncode(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice(2);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One back-channel call: no redirects followed, bounded in time and size, the JSON body parsed when there is one. */
async function call(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
): Promise<Answer> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, { ...init, headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS });
  } catch (err) {
    throw new OidcUnavailableError(`${where(url)} could not be reached: ${errorMessage(err)}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        throw new OidcUnavailableError(`${where(url)} answered with more than 64 KB`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof OidcUnavailableError) throw err;
    throw new OidcUnavailableError(`${where(url)} broke off its answer: ${errorMessage(err)}`);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

/** Check a discovery document against the configured issuer; refuses rather than downgrading any of it. */
export function parseDiscovery(doc: unknown, issuer: string, production: boolean): OidcDiscovery {
  if (!isRecord(doc)) throw new OidcUnavailableError('the discovery document is not a JSON object');
  if (doc.issuer !== issuer) {
    throw new OidcUnavailableError(
      `the discovery document names issuer ${JSON.stringify(doc.issuer)}, not OIDC_ISSUER ${JSON.stringify(issuer)} — they must match exactly, trailing slash included`,
    );
  }
  const endpoint = (field: string, required: boolean): string | null => {
    const value = doc[field];
    if (value === undefined && !required) return null;
    let parsed: URL | null = null;
    try {
      parsed = typeof value === 'string' ? new URL(value) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new OidcUnavailableError(`the discovery document's ${field} is missing or not an http(s) URL`);
    }
    if (production && parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      throw new OidcUnavailableError(
        `the discovery document's ${field} is plain http, which production refuses`,
      );
    }
    return parsed.href;
  };

  const challenge = doc.code_challenge_methods_supported;
  if (Array.isArray(challenge) && !challenge.includes('S256')) {
    throw new OidcUnavailableError(
      'the provider does not support PKCE S256 (code_challenge_methods_supported)',
    );
  }
  const listed = doc.id_token_signing_alg_values_supported;
  const algorithms = Array.isArray(listed)
    ? ID_TOKEN_ALGORITHMS.filter((alg) => listed.includes(alg))
    : ID_TOKEN_ALGORITHMS;
  if (algorithms.length === 0) {
    throw new OidcUnavailableError(
      `the provider signs ID tokens with none of ${ID_TOKEN_ALGORITHMS.join(', ')} (id_token_signing_alg_values_supported)`,
    );
  }
  const auth = doc.token_endpoint_auth_methods_supported;
  let clientAuth: OidcDiscovery['clientAuth'] = 'client_secret_basic';
  if (Array.isArray(auth) && !auth.includes('client_secret_basic')) {
    if (!auth.includes('client_secret_post')) {
      throw new OidcUnavailableError(
        'the provider accepts neither client_secret_basic nor client_secret_post (token_endpoint_auth_methods_supported)',
      );
    }
    clientAuth = 'client_secret_post';
  }
  return {
    authorizationEndpoint: endpoint('authorization_endpoint', true)!,
    tokenEndpoint: endpoint('token_endpoint', true)!,
    jwksUri: endpoint('jwks_uri', true)!,
    userinfoEndpoint: endpoint('userinfo_endpoint', false),
    algorithms,
    clientAuth,
    issParameter: doc.authorization_response_iss_parameter_supported === true,
  };
}

function profileOf(claims: Record<string, unknown>): Omit<IdpClaims, 'subject'> {
  return {
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : null,
    preferredUsername: typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
  };
}

// Their verification failures are the provider's keys being unreachable, not its token being bad.
function jwksUnreachable(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) return true;
  if (!(err instanceof joseErrors.JOSEError)) return true;
  return err.code === 'ERR_JOSE_GENERIC' && /JSON Web Key Set/.test(err.message);
}

function idTokenRefusal(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired && err.claim === 'iat') {
    return `the ID token was issued too long ago (iat) — check this machine's clock against the provider's: ${err.message}`;
  }
  if (err instanceof joseErrors.JWTExpired) {
    return `the ID token has expired (exp) — if it was just issued, check this machine's clock against the provider's: ${err.message}`;
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed && ['iat', 'nbf'].includes(err.claim)) {
    return `the ID token's ${err.claim} is out of range — check this machine's clock against the provider's: ${err.message}`;
  }
  return `the ID token failed verification: ${errorMessage(err)}`;
}

/** The confidential relying party for ONE issuer; its calls reach operator configuration, so they bypass the step SSRF guard as CLERK_API_URL does. */
@Injectable()
export class OidcRelyingParty {
  private cached: { discovery: LoadedDiscovery; fetchedAt: number } | null = null;

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  private get env(): EnvConfig {
    return this.config.get('env', { infer: true });
  }

  /** The redirect URI the provider must have registered, derived from FRONTEND_URL. */
  get redirectUri(): string {
    return `${new URL(this.env.frontendUrl).origin}${OIDC_CALLBACK_PATH}`;
  }

  /** The checked discovery document, cached for an hour; a failure is never cached. */
  async discovery(): Promise<LoadedDiscovery> {
    if (this.cached && Date.now() - this.cached.fetchedAt < DISCOVERY_TTL_MS) return this.cached.discovery;
    this.cached = null;
    const issuer = this.env.oidcIssuer;
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const answer = await call(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (answer.status !== 200) {
      throw new OidcUnavailableError(`${where(url)} answered ${answer.status}, not the discovery document`);
    }
    const parsed = parseDiscovery(answer.json, issuer, this.env.environment === 'production');
    const discovery = {
      ...parsed,
      keys: createRemoteJWKSet(new URL(parsed.jwksUri), { timeoutDuration: 5_000 }),
    };
    this.cached = { discovery, fetchedAt: Date.now() };
    return discovery;
  }

  /** Drop the cached discovery, so the next sign-in fetches it afresh. */
  forget(): void {
    this.cached = null;
  }

  authorizeUrl(
    discovery: OidcDiscovery,
    flow: { state: string; nonce: string; codeVerifier: string },
  ): string {
    const url = new URL(discovery.authorizationEndpoint);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: this.env.oidcClientId,
      redirect_uri: this.redirectUri,
      scope: SCOPE,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: pkceChallenge(flow.codeVerifier),
      code_challenge_method: 'S256',
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Redeem an authorization code for a verified identity: the token exchange, the ID token's every check, and UserInfo when the email was held back. */
  async redeem(
    discovery: LoadedDiscovery,
    flow: { code: string; codeVerifier: string; nonce: string },
  ): Promise<IdpClaims> {
    try {
      const tokens = await this.exchange(discovery, flow);
      const payload = await this.verifyIdToken(discovery, tokens.idToken, flow.nonce);
      const subject = payload.sub as string;
      const fromToken = profileOf(payload);
      if (fromToken.email !== null || !discovery.userinfoEndpoint || !tokens.accessToken) {
        return { subject, ...fromToken };
      }
      const fromUserinfo = await this.userinfo(discovery.userinfoEndpoint, tokens.accessToken, subject);
      return {
        subject,
        email: fromUserinfo.email,
        emailVerified: fromUserinfo.emailVerified,
        name: fromToken.name ?? fromUserinfo.name,
        preferredUsername: fromToken.preferredUsername ?? fromUserinfo.preferredUsername,
      };
    } catch (err) {
      if (err instanceof OidcUnavailableError) this.forget();
      throw err;
    }
  }

  private async exchange(
    discovery: OidcDiscovery,
    flow: { code: string; codeVerifier: string },
  ): Promise<{ idToken: string; accessToken: string | null }> {
    const { oidcClientId: id, oidcClientSecret: secret } = this.env;
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: flow.code,
      redirect_uri: this.redirectUri,
      code_verifier: flow.codeVerifier,
    });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (discovery.clientAuth === 'client_secret_post') {
      form.set('client_id', id);
      form.set('client_secret', secret);
    } else {
      headers.authorization = `Basic ${Buffer.from(`${formEncode(id)}:${formEncode(secret)}`).toString('base64')}`;
    }
    const answer = await call(discovery.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
    if (answer.status === 400 || answer.status === 401) {
      const said =
        isRecord(answer.json) && typeof answer.json.error === 'string'
          ? answer.json.error
          : '(no error code)';
      throw new OidcRejectedError(
        `the token endpoint refused the code (${answer.status}): ${redactSecrets(said).slice(0, 200)}`,
      );
    }
    if (answer.status !== 200) {
      throw new OidcUnavailableError(
        `${where(discovery.tokenEndpoint)} answered ${answer.status} to the code exchange`,
      );
    }
    const body = answer.json;
    if (!isRecord(body) || typeof body.id_token !== 'string' || !body.id_token) {
      throw new OidcUnavailableError(`${where(discovery.tokenEndpoint)} answered without an ID token`);
    }
    return {
      idToken: body.id_token,
      accessToken: typeof body.access_token === 'string' && body.access_token ? body.access_token : null,
    };
  }

  private async verifyIdToken(
    discovery: LoadedDiscovery,
    idToken: string,
    nonce: string,
  ): Promise<JWTPayload> {
    const env = this.env;
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      verified = await jwtVerify(idToken, discovery.keys, {
        issuer: env.oidcIssuer,
        audience: env.oidcClientId,
        algorithms: discovery.algorithms,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_ID_TOKEN_AGE,
        requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
      });
    } catch (err) {
      if (jwksUnreachable(err)) {
        throw new OidcUnavailableError(
          `the provider's keys (jwks_uri) could not be read: ${errorMessage(err)}`,
        );
      }
      throw new OidcRejectedError(idTokenRefusal(err));
    }
    const { payload, protectedHeader } = verified;
    const typ = protectedHeader.typ?.toLowerCase().replace(/^application\//, '');
    if (typ === 'at+jwt') throw new OidcRejectedError('the ID token is an access token (typ at+jwt)');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.length > 1 && payload.azp === undefined) {
      throw new OidcRejectedError('the ID token names several audiences and no authorized party (azp)');
    }
    if (payload.azp !== undefined && payload.azp !== env.oidcClientId) {
      throw new OidcRejectedError('the ID token was issued to another client (azp)');
    }
    if (typeof payload.nonce !== 'string' || !sameText(payload.nonce, nonce)) {
      throw new OidcRejectedError('the ID token answers another sign-in (nonce)');
    }
    const subject = payload.sub;
    if (
      typeof subject !== 'string' ||
      subject.length === 0 ||
      subject.length > 255 ||
      /\p{Cc}/u.test(subject)
    ) {
      throw new OidcRejectedError('the ID token names no usable subject (sub)');
    }
    return payload;
  }

  private async userinfo(
    endpoint: string,
    accessToken: string,
    subject: string,
  ): Promise<Omit<IdpClaims, 'subject'>> {
    const answer = await call(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new OidcRejectedError(`the UserInfo endpoint refused the access token (${answer.status})`);
    }
    if (answer.status !== 200) throw new OidcUnavailableError(`${where(endpoint)} answered ${answer.status}`);
    if (!isRecord(answer.json)) return profileOf({});
    if (answer.json.sub !== subject) {
      throw new OidcRejectedError('the UserInfo endpoint answered for another subject (sub)');
    }
    return profileOf(answer.json);
  }
}
