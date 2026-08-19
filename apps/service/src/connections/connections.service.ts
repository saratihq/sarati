import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ILike, IsNull } from 'typeorm';
import type { DataSource } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { EncryptionService } from '../common/crypto/encryption.service';
import { errorMessage } from '../common/error-message';
import { ConnectionEntity } from '../database/entities/connection.entity';
import { newId, now } from '../database/ids';
import { ComposioProvider, ComposioUpstreamError } from './composio.provider';
import { OAuthExchangeError, refreshAccessToken, type OAuthTokenSet } from './oauth-token';
import type { PlatformKeyScope } from '../platform/platform-keys.service';
import {
  byoClientToConfig,
  OAuthProvidersService,
  type OAuthProviderConfig,
  parseByoClient,
} from './oauth-providers';

/** Refresh when the access token expires within this window (or already has). */
const REFRESH_SKEW_MS = 60_000;

/** Health reasons stored on the row and shown VERBATIM by the client — product copy, never raw provider errors. */
const REASON_EXPIRED_NO_REFRESH =
  'Access has expired and cannot be renewed automatically — reconnect this account.';
const REASON_REFRESH_DECLINED = 'The provider declined to renew access — reconnect this account.';
const REASON_PROVIDER_EXPIRED = 'The provider reports this connection as expired — reconnect this account.';
const REASON_BROKEN = 'This connection stopped working — reconnect this account.';
const REASON_UNREADABLE =
  'The stored credential can no longer be read — remove this connection and connect again.';

/** Deliberately-unusable placeholder a managed row resolves to — Composio masks the real token, so none can leak. */
export const MANAGED_TOKEN_PREFIX = '__ORCHESTR_MANAGED__:';

/** A provider only names an app an action id can address (`<app>.<action>`) when it matches this. */
const PUBLIC_APP_SLUG_RE = /^[a-z][a-z0-9_-]*$/;

/** Public (secret-free) view of a connection. */
export interface ConnectionSummary {
  id: string;
  provider: string;
  display_name: string | null;
  auth_type: string;
  created_at: string | null;
  /** `pending` | `active` | `expired` | `failed` — flips both ways as renewals/health checks succeed or fail. */
  status: string;
  /** Plain-language reason when status is expired/failed; null otherwise. */
  status_reason: string | null;
  /** ISO time health was last verified (test probe, poll flip, or run-time renewal). */
  last_checked_at: string | null;
}

/** A health transition the service can persist (pending is owned by the connect poll). */
export type ConnectionHealthStatus = 'active' | 'expired' | 'failed';

/** Outcome of the liveness probe (POST /api/connections/:id/test). */
export interface ConnectionTestResult {
  ok: boolean;
  /** The connection's (possibly updated) status after the probe. */
  status: string;
  /** Plain language: what broke, or how deep the check actually went. */
  detail: string;
}

/**
 * A connection as an AUTHORING reference — the id a node carries as `connectionId`, plus the few facts
 * that pick the right one. Deliberately id-and-status only: no display name, no owner, no credential material.
 */
export interface ConnectionChoice {
  id: string;
  /** The app this account is for, as stored. */
  provider: string;
  /** The addressable `<app>` half of an action id, or null when the stored provider is not a public slug. */
  app_slug: string | null;
  /** `managed` = broker-held auth (Composio); `byo` = a credential of the user's own. */
  kind: 'managed' | 'byo';
  status: string;
  /** The instance a BYO OAuth connection authorizes against — the disambiguator for self-hosted apps. */
  host?: string;
}

/** One page of {@link ConnectionChoice}s. */
export interface ConnectionChoicePage {
  items: ConnectionChoice[];
  hasMore: boolean;
}

/** A managed row's lifecycle handle (status endpoint + delete cascade). */
export interface ManagedConnectionRef {
  id: string;
  authType: string;
  status: string;
  /** Composio connected-account id; null for non-managed rows. */
  connectedAccountId: string | null;
}

export interface CreateConnectionInput {
  /** The app this account is for — the public slug, e.g. `slack`. */
  provider: string;
  /** The credential the action's auth seam expects — a token string or an object. */
  credential: unknown;
  displayName?: string;
}

/** Stores a provider credential (`token` or `oauth2`) Fernet-encrypted at rest and resolves it for the action auth seam. */
/**
 * The scope whose Composio key manages this account: the owning ORG when the row is an org's,
 * otherwise the owning user. Null only for a row with neither, which cannot be managed.
 */
export function scopeOfConnection(row: ConnectionEntity): PlatformKeyScope | null {
  if (row.orgId) return { kind: 'org', orgId: row.orgId };
  return row.userId ? { kind: 'user', userId: row.userId } : null;
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    // Absent → oauth2 credentials are returned as stored (no refresh possible).
    @Optional() private readonly oauthProviders?: OAuthProvidersService,
    // Absent → deleting a managed row skips the (best-effort anyway) Composio account cleanup.
    @Optional() private readonly composio?: ComposioProvider,
  ) {}

  /** Whether the managed rail (Composio) is configured for this scope — the client's managed-first vs BYO-only signal. */
  async managedConfigured(scope: PlatformKeyScope): Promise<boolean> {
    return (await this.composio?.isConfigured(scope)) ?? false;
  }

  async createToken(userId: string, input: CreateConnectionInput): Promise<ConnectionSummary> {
    const entity = new ConnectionEntity();
    entity.id = newId();
    entity.userId = userId;
    entity.provider = input.provider;
    entity.displayName = input.displayName ?? null;
    entity.authType = 'token';
    entity.credential = this.encryption.encryptToken(JSON.stringify(input.credential));
    entity.createdAt = now();
    entity.status = 'active';
    await this.dataSource.manager.save(ConnectionEntity, entity);
    return toSummary(entity);
  }

  /** A managed (Composio-brokered) connection, created PENDING; stores only the connected-account reference, no secret. */
  async createManaged(
    userId: string,
    provider: string,
    connectedAccountId: string,
    /** When set, this is an ORG CLUSTER connection for an environment (not personal). */
    cluster?: { orgId: string; environment: string },
  ): Promise<ConnectionSummary> {
    const entity = new ConnectionEntity();
    entity.id = newId();
    entity.userId = userId;
    entity.provider = provider;
    entity.displayName = null;
    entity.authType = 'managed';
    entity.credential = this.encryption.encryptToken(
      JSON.stringify({ connected_account_id: connectedAccountId }),
    );
    entity.createdAt = now();
    entity.status = 'pending';
    entity.orgId = cluster?.orgId ?? null;
    entity.environment = cluster?.environment ?? null;

    if (!cluster) {
      await this.dataSource.manager.save(ConnectionEntity, entity);
      return toSummary(entity);
    }

    // Cluster upsert-on-rotate (one account per app per env): revoke the OUTGOING grant first,
    // outside the tx, then swap the row atomically so a concurrent connect can't remove the new one.
    const existing = await this.dataSource.manager.find(ConnectionEntity, {
      where: { orgId: cluster.orgId, environment: cluster.environment, provider },
    });
    for (const row of existing) await this.revokeComposioAccount(row);
    try {
      await this.dataSource.transaction(async (em) => {
        await em.delete(ConnectionEntity, {
          orgId: cluster.orgId,
          environment: cluster.environment,
          provider,
        });
        await em.save(ConnectionEntity, entity);
      });
    } catch (err) {
      // Lost the unique-index race for the same (org, env, app) — a clean 409, not a raw 500.
      const code = (err as { driverError?: { code?: string }; code?: string }) ?? {};
      if (code.driverError?.code === '23505' || code.code === '23505') {
        throw new DomainError(
          `A ${provider} connection for the ${cluster.environment} environment is already being set up — try again in a moment`,
          409,
        );
      }
      throw err;
    }
    return toSummary(entity);
  }

  /** The lifecycle handle for the status endpoint; null when not the user's row. */
  async managedRef(userId: string, id: string): Promise<ManagedConnectionRef | null> {
    const row = await this.dataSource.manager.findOne(ConnectionEntity, { where: { id, userId } });
    if (!row) return null;
    return {
      id: row.id,
      authType: row.authType,
      status: row.status,
      connectedAccountId: row.authType === 'managed' ? this.connectedAccountIdOf(row) : null,
    };
  }

  /** Persist a health transition; `active` clears the reason and `last_checked_at` records the verification. */
  async setStatus(id: string, status: ConnectionHealthStatus, reason: string | null = null): Promise<void> {
    await this.dataSource.manager.update(
      ConnectionEntity,
      { id },
      { status, statusReason: status === 'active' ? null : reason, lastCheckedAt: now() },
    );
  }

  /**
   * THE env-scoped resolver for `(environment_id, app)` — returns the pool row AND its owner,
   * since the step must run AS the owner; null on an empty slot, and callers must never fall back to a personal pool.
   */
  async resolveSlotConnection(
    environmentId: string,
    app: string,
  ): Promise<{ id: string; ownerUserId: string } | null> {
    const rows: Array<{ id: string; user_id: string }> = await this.dataSource.query(
      `SELECT c.id, c.user_id
         FROM environment_connections ec
         JOIN connections c ON c.id = ec.connection_id
        WHERE ec.environment_id = $1 AND ec.app = $2`,
      [environmentId, app],
    );
    const row = rows[0];
    return row ? { id: row.id, ownerUserId: row.user_id } : null;
  }

  /** LEGACY resolution by `(org, env name, app)` for rows carrying an env NAME but no environment_id; new fires use `resolveSlotConnection`. */
  async resolveClusterConnection(
    orgId: string,
    environment: string,
    provider: string,
  ): Promise<{ id: string; ownerUserId: string } | null> {
    const row = await this.dataSource.manager.findOne(ConnectionEntity, {
      where: { orgId, environment, provider, status: 'active' },
      select: { id: true, userId: true },
    });
    return row ? { id: row.id, ownerUserId: row.userId } : null;
  }

  /** Store a completed OAuth2 flow's tokens under the standard OAuth field names the auth seam reads. */
  async createOAuth2(
    userId: string,
    provider: string,
    tokens: OAuthTokenSet,
    displayName?: string,
    /** BYO OAuth: the already-encrypted own-client blob to retain for refresh. */
    oauthClientEnc?: string | null,
  ): Promise<ConnectionSummary> {
    const credential: Record<string, unknown> = {
      access_token: tokens.access_token,
      token_type: tokens.token_type ?? 'Bearer',
    };
    if (tokens.refresh_token) credential.refresh_token = tokens.refresh_token;
    if (tokens.scope) credential.scope = tokens.scope;
    if (typeof tokens.expires_in === 'number') {
      credential.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    }

    const entity = new ConnectionEntity();
    entity.id = newId();
    entity.userId = userId;
    entity.provider = provider;
    entity.displayName = displayName ?? null;
    entity.authType = 'oauth2';
    entity.credential = this.encryption.encryptToken(JSON.stringify(credential));
    entity.oauthClient = oauthClientEnc ?? null;
    entity.createdAt = now();
    entity.status = 'active';
    await this.dataSource.manager.save(ConnectionEntity, entity);
    return toSummary(entity);
  }

  /**
   * The OAuth config used to REFRESH a row's token: a BYO row's own encrypted client, else the env-configured provider.
   * A corrupt stored client degrades to null ("not configured") rather than throwing into a run.
   */
  private oauthCfgForRow(row: ConnectionEntity): OAuthProviderConfig | null {
    if (row.oauthClient) {
      const byo = parseByoClient(this.encryption.decryptToken(row.oauthClient));
      if (byo) return byoClientToConfig(row.provider, byo, this.oauthProviders?.redirectUri ?? '');
      this.logger.warn(`Connection ${row.id} (${row.provider}): stored BYO OAuth client is unreadable`);
      return null;
    }
    return this.oauthProviders?.get(row.provider) ?? null;
  }

  /** Rename a PERSONAL connection (null/empty clears back to the provider name). */
  async rename(id: string, userId: string, displayName: string | null): Promise<ConnectionSummary | null> {
    const row = await this.dataSource.manager.findOne(ConnectionEntity, {
      where: { id, userId, orgId: IsNull() },
    });
    if (!row) return null;
    row.displayName = displayName;
    await this.dataSource.manager.save(ConnectionEntity, row);
    return toSummary(row);
  }

  async list(userId: string): Promise<ConnectionSummary[]> {
    // PERSONAL only — org cluster rows (orgId set) must not leak into the personal surface.
    const rows = await this.dataSource.manager.find(ConnectionEntity, {
      where: { userId, orgId: IsNull() },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toSummary);
  }

  /**
   * One page of the caller's OWN connections as authoring references — never another user's
   * rows, and never credential material. `query` matches the provider; ordering is stable so offset paging is too.
   */
  async listChoices(
    userId: string,
    opts: { query?: string; limit: number; offset: number },
  ): Promise<ConnectionChoicePage> {
    const query = opts.query?.trim();
    const rows = await this.dataSource.manager.find(ConnectionEntity, {
      where: {
        userId,
        orgId: IsNull(),
        ...(query ? { provider: ILike(`%${query}%`) } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: opts.offset,
      take: opts.limit + 1,
    });
    return {
      items: rows.slice(0, opts.limit).map((row) => this.toChoice(row)),
      hasMore: rows.length > opts.limit,
    };
  }

  private toChoice(row: ConnectionEntity): ConnectionChoice {
    const host = this.byoHost(row);
    return {
      id: row.id,
      provider: row.provider,
      app_slug: PUBLIC_APP_SLUG_RE.test(row.provider) ? row.provider : null,
      kind: row.authType === 'managed' ? 'managed' : 'byo',
      status: row.status || 'active',
      ...(host ? { host } : {}),
    };
  }

  /** The BYO OAuth client's authorize HOST and nothing else; an unreadable blob costs a hostname, never the listing. */
  private byoHost(row: ConnectionEntity): string | undefined {
    if (!row.oauthClient) return undefined;
    try {
      const byo = parseByoClient(this.encryption.decryptToken(row.oauthClient));
      return byo ? new URL(byo.authUrl).hostname || undefined : undefined;
    } catch (err) {
      const message = errorMessage(err);
      this.logger.warn(`Connection ${row.id}: BYO OAuth host is unreadable: ${message}`);
      return undefined;
    }
  }

  async delete(userId: string, id: string): Promise<boolean> {
    // Personal-scoped: a cluster row (orgId set) is removable only via deleteCluster, which enforces owner/admin.
    const row = await this.dataSource.manager.findOne(ConnectionEntity, {
      where: { id, userId, orgId: IsNull() },
    });
    if (!row) return false;
    const res = await this.dataSource.manager.delete(ConnectionEntity, { id, userId, orgId: IsNull() });
    const removed = (res.affected ?? 0) > 0;
    if (removed) await this.revokeComposioAccount(row);
    return removed;
  }

  /** How many cluster connections in an org a given member owns (env steps run AS them). */
  async countClusterConnectionsOwnedBy(orgId: string, userId: string): Promise<number> {
    return this.dataSource.manager.count(ConnectionEntity, { where: { orgId, userId } });
  }

  /** Every ORG CLUSTER connection (env + its owner) — for the owner UI. */
  async listClusters(
    orgId: string,
  ): Promise<
    Array<ConnectionSummary & { environment: string | null; owner: { id: string; name: string | null } }>
  > {
    const rows: Array<{
      id: string;
      provider: string;
      display_name: string | null;
      auth_type: string;
      created_at: Date | null;
      status: string;
      status_reason: string | null;
      last_checked_at: Date | null;
      environment: string | null;
      owner_id: string;
      owner_name: string | null;
    }> = await this.dataSource.query(
      `SELECT c.id, c.provider, c.display_name, c.auth_type, c.created_at, c.status,
              c.status_reason, c.last_checked_at, c.environment,
              c.user_id AS owner_id, u.name AS owner_name
         FROM connections c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.org_id = $1
        ORDER BY c.environment ASC, c.created_at DESC`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      display_name: r.display_name,
      auth_type: r.auth_type,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      status: r.status,
      status_reason: r.status_reason,
      last_checked_at: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
      environment: r.environment,
      owner: { id: r.owner_id, name: r.owner_name },
    }));
  }

  /** Delete a cluster connection (ORG-scoped, not user-scoped) + revoke its Composio account. */
  async deleteCluster(orgId: string, id: string): Promise<boolean> {
    const row = await this.dataSource.manager.findOne(ConnectionEntity, { where: { id, orgId } });
    if (!row) return false;
    const res = await this.dataSource.manager.delete(ConnectionEntity, { id, orgId });
    const removed = (res.affected ?? 0) > 0;
    if (removed) await this.revokeComposioAccount(row);
    return removed;
  }

  /** Best-effort cascade revoking the Composio account; a failure must not resurrect the row — log and move on. */
  private async revokeComposioAccount(row: ConnectionEntity): Promise<void> {
    const composio = this.composio;
    const scope = scopeOfConnection(row);
    if (row.authType !== 'managed' || !composio || !scope || !(await composio.isConfigured(scope))) return;
    const accountId = this.connectedAccountIdOf(row);
    if (!accountId) return;
    try {
      await composio.deleteAccount(scope, accountId);
    } catch (err) {
      const message = errorMessage(err);
      this.logger.warn(
        `Connection ${row.id}: Composio account ${accountId} could not be deleted: ${message}`,
      );
    }
  }

  /**
   * The decrypted credential for the auth seam (null when not the user's row) — resolved at run time so the
   * secret never lands in a checkpoint; oauth2 refreshes near expiry, managed rows resolve to MANAGED_TOKEN_PREFIX.
   */
  async getCredential(userId: string, id: string): Promise<unknown> {
    const row = await this.dataSource.manager.findOne(ConnectionEntity, { where: { id, userId } });
    if (!row) return null;
    if (row.authType === 'managed') return await this.managedCredential(row);
    const decrypted = this.encryption.decryptToken(row.credential);
    let credential: unknown;
    try {
      credential = JSON.parse(decrypted) as unknown;
    } catch {
      return decrypted;
    }
    if (row.authType !== 'oauth2' || credential === null || typeof credential !== 'object') {
      return credential;
    }
    return this.freshOAuthCredential(row, credential as Record<string, unknown>);
  }

  /**
   * A managed row's sentinel credential: `access_token`/`secret_text` are never real tokens, `data` holds
   * non-secret account metadata. Not-yet-active rows throw; metadata enrichment degrades to the bare sentinel.
   */
  private async managedCredential(row: ConnectionEntity): Promise<Record<string, unknown>> {
    if (row.status !== 'active') {
      throw new Error(
        `Connection ${row.id} (${row.provider}) is not active yet — complete the connect flow, then retry`,
      );
    }
    const accountId = this.connectedAccountIdOf(row);
    if (!accountId) {
      throw new Error(`Connection ${row.id} (${row.provider}) has no Composio account reference`);
    }
    const sentinel = `${MANAGED_TOKEN_PREFIX}${accountId}`;
    const credential: Record<string, unknown> = { access_token: sentinel, secret_text: sentinel };

    const composio = this.composio;
    const scope = scopeOfConnection(row);
    if (composio && scope && (await composio.isConfigured(scope))) {
      try {
        const data = await composio.getAccountMetadata(scope, accountId);
        if (Object.keys(data).length > 0) credential.data = data;
      } catch (err) {
        const message = errorMessage(err);
        this.logger.warn(
          `Connection ${row.id} (${row.provider}): could not fetch account metadata: ${message}`,
        );
      }
    }
    return credential;
  }

  /** The Composio connected-account id stored in a managed row's credential blob. */
  private connectedAccountIdOf(row: ConnectionEntity): string | null {
    try {
      const parsed: unknown = JSON.parse(this.encryption.decryptToken(row.credential));
      if (parsed !== null && typeof parsed === 'object') {
        const id = (parsed as Record<string, unknown>).connected_account_id;
        if (typeof id === 'string' && id) return id;
      }
    } catch {
      // fall through — a corrupt blob reads as "no reference"
    }
    return null;
  }

  /**
   * The oauth2 credential with a live access token — refreshed (last-write-wins) within REFRESH_SKEW_MS of expiry.
   * An EXPIRED token that cannot be refreshed throws AND flips the row to `expired`; a still-valid one degrades to stored.
   */
  private async freshOAuthCredential(
    row: ConnectionEntity,
    credential: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const expiresAt = oauthExpiryOf(credential);
    if (Number.isNaN(expiresAt) || expiresAt - Date.now() > REFRESH_SKEW_MS) return credential;

    const expired = expiresAt <= Date.now();
    const refreshToken = typeof credential.refresh_token === 'string' ? credential.refresh_token : null;
    const cfg = this.oauthCfgForRow(row);
    if (!refreshToken || !cfg) {
      const why = !refreshToken
        ? 'no refresh_token was granted'
        : `provider "${row.provider}" is not configured`;
      if (expired) {
        await this.setStatus(row.id, 'expired', REASON_EXPIRED_NO_REFRESH);
        throw new Error(`Connection ${row.id} (${row.provider}): access token expired and ${why}`);
      }
      this.logger.warn(`Connection ${row.id} (${row.provider}) expires soon but ${why}`);
      return credential;
    }

    try {
      return await this.refreshAndPersist(row, credential, cfg, refreshToken);
    } catch (err) {
      const message = errorMessage(err);
      if (expired) {
        await this.setStatus(row.id, 'expired', REASON_REFRESH_DECLINED);
        throw new Error(`Connection ${row.id} (${row.provider}): token refresh failed: ${message}`);
      }
      this.logger.warn(
        `Connection ${row.id} (${row.provider}): early refresh failed, using stored token: ${message}`,
      );
      return credential;
    }
  }

  /** Redeem the refresh token, persist the rotated set, and mark the row `active` — a successful grant IS a verification. */
  private async refreshAndPersist(
    row: ConnectionEntity,
    credential: Record<string, unknown>,
    cfg: OAuthProviderConfig,
    refreshToken: string,
  ): Promise<Record<string, unknown>> {
    const tokens = await refreshAccessToken(cfg, refreshToken);
    const updated: Record<string, unknown> = {
      ...credential,
      access_token: tokens.access_token,
      token_type: tokens.token_type ?? credential.token_type ?? 'Bearer',
    };
    if (tokens.refresh_token) updated.refresh_token = tokens.refresh_token; // rotation
    if (tokens.scope) updated.scope = tokens.scope;
    if (typeof tokens.expires_in === 'number') {
      updated.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    } else {
      // No expiry reported — drop the stale one so we don't refresh on every resolution.
      delete updated.expires_at;
    }
    await this.dataSource.manager.update(
      ConnectionEntity,
      { id: row.id },
      {
        credential: this.encryption.encryptToken(JSON.stringify(updated)),
        status: 'active',
        statusReason: null,
        lastCheckedAt: now(),
      },
    );
    return updated;
  }

  // ─── Health probe (POST /api/connections/:id/test) ───

  /**
   * A cheap liveness probe whose depth varies by auth type and is stated honestly in `detail`; null when not the user's row.
   * Indeterminate outcomes (provider/Composio unreachable) persist nothing — we learned nothing about the grant.
   */
  async test(userId: string, id: string): Promise<ConnectionTestResult | null> {
    const row = await this.dataSource.manager.findOne(ConnectionEntity, { where: { id, userId } });
    if (!row) return null;
    if (row.authType === 'managed') return this.probeManaged(row);
    if (row.authType === 'oauth2') return this.probeOAuth2(row);
    return this.probeStored(row);
  }

  /** Managed rows: ask Composio for the connected account's current status. */
  private async probeManaged(row: ConnectionEntity): Promise<ConnectionTestResult> {
    const composio = this.composio;
    const scope = scopeOfConnection(row);
    if (!composio || !scope || !(await composio.isConfigured(scope))) {
      return {
        ok: false,
        status: row.status,
        detail: 'Managed connections are not configured for this account, so it cannot be checked.',
      };
    }
    const accountId = this.connectedAccountIdOf(row);
    if (!accountId) {
      await this.setStatus(row.id, 'failed', REASON_UNREADABLE);
      return { ok: false, status: 'failed', detail: REASON_UNREADABLE };
    }
    let account: 'pending' | 'active' | 'expired' | 'failed';
    try {
      account = await composio.getAccountStatus(scope, accountId);
    } catch (err) {
      // 5xx/network and 4xx alike tell us nothing reliable about the grant, so the row keeps its status.
      const kind = err instanceof ComposioUpstreamError ? 'unreachable' : 'rejected the check';
      this.logger.warn(`Connection ${row.id} (${row.provider}): Composio ${kind}: ${errorMessage(err)}`);
      return {
        ok: false,
        status: row.status,
        detail: 'The connection service could not be reached — try again shortly.',
      };
    }
    if (account === 'active') {
      await this.setStatus(row.id, 'active');
      return { ok: true, status: 'active', detail: 'The provider reports this connection as active.' };
    }
    if (account === 'pending') {
      return {
        ok: false,
        status: row.status,
        detail: 'The sign-in was never finished — reconnect to complete it.',
      };
    }
    const reason = account === 'expired' ? REASON_PROVIDER_EXPIRED : REASON_BROKEN;
    await this.setStatus(row.id, account, reason);
    return { ok: false, status: account, detail: reason };
  }

  /** oauth2 rows: a forced refresh when possible, else an expiry check on the stored token. */
  private async probeOAuth2(row: ConnectionEntity): Promise<ConnectionTestResult> {
    let credential: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(this.encryption.decryptToken(row.credential));
      if (parsed === null || typeof parsed !== 'object') throw new Error('credential is not an object');
      credential = parsed as Record<string, unknown>;
    } catch {
      await this.setStatus(row.id, 'failed', REASON_UNREADABLE);
      return { ok: false, status: 'failed', detail: REASON_UNREADABLE };
    }

    const refreshToken = typeof credential.refresh_token === 'string' ? credential.refresh_token : null;
    const cfg = this.oauthCfgForRow(row);
    if (refreshToken && cfg) {
      try {
        await this.refreshAndPersist(row, credential, cfg, refreshToken);
        return { ok: true, status: 'active', detail: 'Access was renewed with the provider.' };
      } catch (err) {
        const message = errorMessage(err);
        this.logger.warn(`Connection ${row.id} (${row.provider}): test refresh failed: ${message}`);
        if (err instanceof OAuthExchangeError) {
          // The provider SAW the grant and said no — the refresh token is dead.
          await this.setStatus(row.id, 'expired', REASON_REFRESH_DECLINED);
          return { ok: false, status: 'expired', detail: REASON_REFRESH_DECLINED };
        }
        // Network problem — indeterminate, keep the current status.
        return {
          ok: false,
          status: row.status,
          detail: 'The provider could not be reached — try again shortly.',
        };
      }
    }

    // No refresh path: the stored token's expiry is all that can be checked.
    const expiresAt = oauthExpiryOf(credential);
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
      await this.setStatus(row.id, 'expired', REASON_EXPIRED_NO_REFRESH);
      return { ok: false, status: 'expired', detail: REASON_EXPIRED_NO_REFRESH };
    }
    await this.setStatus(row.id, 'active');
    return {
      ok: true,
      status: 'active',
      detail: Number.isNaN(expiresAt)
        ? 'The token is stored, but without a refresh token it can only be fully verified by running a step.'
        : `The token is valid until ${new Date(expiresAt).toISOString()}, but without a refresh token it cannot be verified with the provider.`,
    };
  }

  /** token/API-key rows: shape only — stored and decryptable. Honest about the depth. */
  private async probeStored(row: ConnectionEntity): Promise<ConnectionTestResult> {
    try {
      if (!this.encryption.decryptToken(row.credential)) throw new Error('empty credential');
    } catch {
      await this.setStatus(row.id, 'failed', REASON_UNREADABLE);
      return { ok: false, status: 'failed', detail: REASON_UNREADABLE };
    }
    await this.setStatus(row.id, 'active');
    return {
      ok: true,
      status: 'active',
      detail: 'The API key is stored and readable; it is verified with the provider when a step runs.',
    };
  }
}

/** The credential's absolute expiry in epoch ms, or NaN when absent/unparseable. */
function oauthExpiryOf(credential: Record<string, unknown>): number {
  return typeof credential.expires_at === 'string' ? Date.parse(credential.expires_at) : NaN;
}

function toSummary(e: ConnectionEntity): ConnectionSummary {
  return {
    id: e.id,
    provider: e.provider,
    display_name: e.displayName,
    auth_type: e.authType,
    created_at: e.createdAt ? e.createdAt.toISOString() : null,
    status: e.status || 'active',
    status_reason: e.statusReason ?? null,
    last_checked_at: e.lastCheckedAt ? e.lastCheckedAt.toISOString() : null,
  };
}
