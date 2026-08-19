import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';
import { OAuthStateEntity } from '../database/entities/oauth-state.entity';
import { newId, now } from '../database/ids';
import { ConnectionsService, type ConnectionSummary } from './connections.service';
import {
  assertSafeOAuthEndpoint,
  type ByoOAuthClient,
  byoClientToConfig,
  OAuthProvidersService,
  type OAuthProviderConfig,
  parseByoClient,
} from './oauth-providers';
import { exchangeAuthorizationCode } from './oauth-token';

/** Requested a provider that has no configured OAuth app (missing client id/secret). */
export class OAuthProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`OAuth provider "${provider}" is not configured`);
  }
}

/** The callback's `state` didn't match a live, single-use row for this user. */
export class OAuthStateError extends Error {
  constructor() {
    super('Invalid or expired OAuth state');
  }
}

const STATE_TTL_MS = 10 * 60_000;

function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE S256 challenge = base64url(sha256(verifier)). */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The OAuth2 authorization-code flow: authorize → consent → callback → token exchange → stored connection.
 * A single-use, 10-min CSRF `state` carries the PKCE verifier server-side and must belong to the calling user.
 */
@Injectable()
export class OAuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providers: OAuthProvidersService,
    private readonly connections: ConnectionsService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Start the authorization-code flow. A `byoClient` runs the identical flow against the user's OWN OAuth
   * app, persisting the encrypted client on the state so the callback and later refresh redeem against the same client.
   */
  async startAuthorization(
    userId: string,
    provider: string,
    byoClient?: ByoOAuthClient,
  ): Promise<{ authorizeUrl: string; state: string }> {
    let cfg: OAuthProviderConfig;
    let encClient: string | null = null;
    if (byoClient) {
      // Guard the user-supplied endpoints BEFORE we persist or ever fetch them.
      await assertSafeOAuthEndpoint('token_url', byoClient.tokenUrl);
      await assertSafeOAuthEndpoint('authorization_url', byoClient.authUrl);
      cfg = byoClientToConfig(provider, byoClient, this.providers.redirectUri);
      encClient = this.encryption.encryptToken(JSON.stringify(byoClient));
    } else {
      const configured = this.providers.get(provider);
      if (!configured) throw new OAuthProviderNotConfiguredError(provider);
      cfg = configured;
    }

    const state = randomToken();
    const codeVerifier = cfg.usePkce ? randomToken(32) : null;
    await this.saveState(userId, provider, state, codeVerifier, encClient);
    return { authorizeUrl: this.buildAuthorizeUrl(cfg, state, codeVerifier), state };
  }

  buildAuthorizeUrl(cfg: OAuthProviderConfig, state: string, codeVerifier: string | null): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      state,
    });
    if (cfg.scopes.length > 0) params.set('scope', cfg.scopes.join(' '));
    for (const [key, value] of Object.entries(cfg.authExtraParams)) params.set(key, value);
    if (cfg.usePkce && codeVerifier) {
      params.set('code_challenge', pkceChallenge(codeVerifier));
      params.set('code_challenge_method', 'S256');
    }
    return `${cfg.authUrl}?${params.toString()}`;
  }

  async completeAuthorization(userId: string, code: string, state: string): Promise<ConnectionSummary> {
    const consumed = await this.consumeState(userId, state);
    if (!consumed) throw new OAuthStateError();

    // A stored own-client redeems the code against itself AND is retained on the connection so refresh can reuse it.
    if (consumed.oauthClient) {
      const byo = parseByoClient(this.encryption.decryptToken(consumed.oauthClient));
      if (!byo) throw new OAuthProviderNotConfiguredError(consumed.provider);
      const cfg = byoClientToConfig(consumed.provider, byo, this.providers.redirectUri);
      const tokens = await exchangeAuthorizationCode(cfg, code, consumed.codeVerifier);
      return this.connections.createOAuth2(
        userId,
        consumed.provider,
        tokens,
        undefined,
        consumed.oauthClient,
      );
    }

    const cfg = this.providers.get(consumed.provider);
    if (!cfg) throw new OAuthProviderNotConfiguredError(consumed.provider);
    const tokens = await exchangeAuthorizationCode(cfg, code, consumed.codeVerifier);
    return this.connections.createOAuth2(userId, consumed.provider, tokens);
  }

  // ─── CSRF state (single-use, 10-min) ───

  private async saveState(
    userId: string,
    provider: string,
    state: string,
    codeVerifier: string | null,
    oauthClient: string | null,
  ): Promise<void> {
    const em = this.dataSource.manager;
    await em.query(`DELETE FROM oauth_states WHERE expires_at < now()`); // opportunistic GC
    const entity = new OAuthStateEntity();
    entity.id = newId();
    entity.state = state;
    entity.userId = userId;
    entity.provider = provider;
    entity.codeVerifier = codeVerifier;
    entity.oauthClient = oauthClient;
    entity.createdAt = now();
    entity.expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await em.save(OAuthStateEntity, entity);
  }

  /** DELETE the state row BEFORE validating it, so a mismatched or expired state still can't be replayed. */
  private async consumeState(
    userId: string,
    state: string,
  ): Promise<{ provider: string; codeVerifier: string | null; oauthClient: string | null } | null> {
    const em = this.dataSource.manager;
    const row = await em.findOne(OAuthStateEntity, { where: { state } });
    if (!row) return null;
    await em.delete(OAuthStateEntity, { id: row.id });
    if (row.userId !== userId || !row.provider) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return { provider: row.provider, codeVerifier: row.codeVerifier, oauthClient: row.oauthClient };
  }
}
