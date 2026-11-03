import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';
import { DomainError } from '../common/domain-error';
import type { EnvConfig } from '../config/env.config';
import { lockOrgForWrite } from '../orgs/org-row-lock';

/** The two optional platform credentials, set from Settings. Widening this set is a migration. */
export const PLATFORM_KEY_NAMES = [
  'composio_api_key',
  'composio_webhook_secret',
  'anthropic_api_key',
] as const;

export type PlatformKeyName = (typeof PLATFORM_KEY_NAMES)[number];

export function isPlatformKeyName(value: string): value is PlatformKeyName {
  return (PLATFORM_KEY_NAMES as readonly string[]).includes(value);
}

const COMPOSIO_KEY_NAMES: ReadonlySet<PlatformKeyName> = new Set([
  'composio_api_key',
  'composio_webhook_secret',
]);

/** Who a stored key belongs to: a user or an organization. The instance's own Composio account is config, never a stored key. */
export type PlatformKeyScope = { kind: 'user'; userId: string } | { kind: 'org'; orgId: string };

const sameScope = (a: PlatformKeyScope, b: PlatformKeyScope): boolean =>
  a.kind === 'user' ? b.kind === 'user' && a.userId === b.userId : b.kind === 'org' && a.orgId === b.orgId;

/** Presence of a key in a scope; the value itself is never part of this. */
export interface PlatformKeyState {
  present: boolean;
  updated_at: string | null;
  /** Provided by this instance for everyone, so it is neither shown as stored nor writable. */
  managed_by_instance: boolean;
}

/**
 * Store for the two optional platform API keys, Fernet-encrypted at rest through the same
 * path as connection credentials. Read per call, never snapshotted, so a key entered in
 * Settings takes effect without a restart. An instance that provides its own Composio account
 * answers with it for every scope, and the scopes' stored Composio keys are kept but unused.
 */
@Injectable()
export class PlatformKeysService {
  private readonly instanceComposio: { apiKey: string; webhookSecret: string };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    config: ConfigService<{ env: EnvConfig }, true>,
  ) {
    const env = config.get('env', { infer: true });
    this.instanceComposio = {
      apiKey: env.instanceComposioApiKey,
      webhookSecret: env.instanceComposioWebhookSecret,
    };
  }

  /**
   * THE scope rule, one definition site: a caller acting in a real organization uses that
   * organization's keys, and a caller in their personal context uses their own. There is no
   * precedence between the two — the active org decides, and it already flows on every request.
   */
  async scopeFor(userId: string, activeOrgId: string | null): Promise<PlatformKeyScope> {
    if (!activeOrgId) return { kind: 'user', userId };
    const rows: Array<{ is_personal: boolean }> = await this.dataSource.query(
      `SELECT is_personal FROM organizations WHERE id = $1`,
      [activeOrgId],
    );
    return rows[0]?.is_personal === false ? { kind: 'org', orgId: activeOrgId } : { kind: 'user', userId };
  }

  /** Whether this instance provides the one Composio account every person's managed connections use. */
  composioManagedByInstance(): boolean {
    return this.instanceComposio.apiKey !== '';
  }

  /** Refuses a key this instance provides itself: it is not anyone's to set or remove. */
  assertWritable(name: PlatformKeyName): void {
    if (COMPOSIO_KEY_NAMES.has(name) && this.composioManagedByInstance()) {
      throw new DomainError(
        'This instance provides its own Composio account to everyone, so its Composio keys cannot be set or removed here',
        409,
        { code: 'provided_by_instance' },
      );
    }
  }

  /** Upsert the key for this scope. Encrypted at rest; never read back over the API. */
  async set(scope: PlatformKeyScope, name: PlatformKeyName, plaintext: string): Promise<void> {
    this.assertWritable(name);
    // Encryption fails OPEN elsewhere for credentials stored before it existed; a key typed in
    // today has no such history, so storing it in the clear is refused rather than done quietly.
    if (!this.encryption.canEncrypt()) {
      throw new DomainError(
        'This instance has no FERNET_KEY, so the key would be stored unencrypted. Set FERNET_KEY and restart, then add it again.',
        503,
      );
    }
    const enc = this.encryption.encryptToken(plaintext);
    // Index INFERENCE, not a constraint name: the uniqueness is a PARTIAL index (the unused
    // owner column is NULL), and `ON CONFLICT ON CONSTRAINT` cannot target one.
    const target =
      scope.kind === 'user'
        ? '(name, user_id) WHERE user_id IS NOT NULL'
        : '(name, org_id) WHERE org_id IS NOT NULL';
    await this.writeIn(scope, (em) =>
      em.query(
        `INSERT INTO platform_secrets (name, user_id, org_id, secret) VALUES ($1, $2, $3, $4)
         ON CONFLICT ${target}
         DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`,
        [name, ...this.owner(scope), enc],
      ),
    );
  }

  /** Remove this scope's key. */
  async clear(scope: PlatformKeyScope, name: PlatformKeyName): Promise<void> {
    this.assertWritable(name);
    await this.writeIn(scope, (em) =>
      em.query(
        `DELETE FROM platform_secrets
          WHERE name = $1 AND user_id IS NOT DISTINCT FROM $2 AND org_id IS NOT DISTINCT FROM $3`,
        [name, ...this.owner(scope)],
      ),
    );
  }

  /** Which keys this scope has, and when each was last written — never the values themselves. */
  async presence(scope: PlatformKeyScope): Promise<Record<PlatformKeyName, PlatformKeyState>> {
    const rows: Array<{ name: string; updated_at: Date }> = await this.dataSource.query(
      `SELECT name, updated_at FROM platform_secrets
        WHERE user_id IS NOT DISTINCT FROM $1 AND org_id IS NOT DISTINCT FROM $2`,
      this.owner(scope),
    );
    const byName = new Map(rows.map((r) => [r.name, r.updated_at]));
    const byInstance = this.composioManagedByInstance();
    return Object.fromEntries(
      PLATFORM_KEY_NAMES.map((name): [PlatformKeyName, PlatformKeyState] => {
        if (byInstance && COMPOSIO_KEY_NAMES.has(name)) {
          return [name, { present: true, updated_at: null, managed_by_instance: true }];
        }
        const at = byName.get(name);
        return [
          name,
          { present: at !== undefined, updated_at: at ? at.toISOString() : null, managed_by_instance: false },
        ];
      }),
    ) as Record<PlatformKeyName, PlatformKeyState>;
  }

  /** The decrypted key this scope stores, or null when unset; read on `em` when given, so a transaction reads it on its own connection. */
  private async stored(
    scope: PlatformKeyScope,
    name: PlatformKeyName,
    em: EntityManager = this.dataSource.manager,
  ): Promise<string | null> {
    const rows: Array<{ secret: string }> = await em.query(
      `SELECT secret FROM platform_secrets
        WHERE name = $1 AND user_id IS NOT DISTINCT FROM $2 AND org_id IS NOT DISTINCT FROM $3
        LIMIT 1`,
      [name, ...this.owner(scope)],
    );
    const row = rows[0];
    return row ? this.encryption.decryptToken(row.secret) : null;
  }

  /**
   * The scope owning a workflow — how a BACKGROUND path (webhook intake, reconciler, reaper)
   * with no caller finds whose key to use. Null when the workflow is gone.
   */
  async scopeForWorkflow(workflowId: string): Promise<PlatformKeyScope | null> {
    const rows: Array<{ user_id: string | null; org_id: string | null }> = await this.dataSource.query(
      `SELECT user_id, org_id FROM workflows WHERE id = $1 LIMIT 1`,
      [workflowId],
    );
    const row = rows[0];
    return row ? this.scopeForOwners(row.user_id, row.org_id) : null;
  }

  /** The scope owning a workflow with these owner columns, through `scopeFor`, so one in a personal org resolves to its user as that person's requests do. */
  async scopeForOwners(userId: string | null, orgId: string | null): Promise<PlatformKeyScope | null> {
    if (userId) return this.scopeFor(userId, orgId);
    return orgId ? { kind: 'org', orgId } : null;
  }

  /** Live Composio subscriptions this scope owns, as {@link scopeForOwners} decides — what a credential change leaves stranded. */
  async liveComposioSubscriptions(
    scope: PlatformKeyScope,
  ): Promise<Array<{ workflowName: string; triggerType: string }>> {
    const [userId, orgId] = this.owner(scope);
    const rows: Array<{
      workflowName: string;
      triggerType: string;
      user_id: string | null;
      org_id: string | null;
    }> = await this.dataSource.query(
      `SELECT w.name AS "workflowName", a.trigger_type AS "triggerType", w.user_id, w.org_id
         FROM runtime_trigger_activations a
         JOIN workflows w ON w.id = a.workflow_id
        WHERE a.composio_trigger_instance_id IS NOT NULL AND a.paused = false
          AND (w.user_id = $1 OR w.org_id = $2)`,
      [userId, orgId],
    );
    const owned: Array<{ workflowName: string; triggerType: string }> = [];
    for (const { user_id, org_id, ...live } of rows) {
      const owner = await this.scopeForOwners(user_id, org_id);
      if (owner && sameScope(owner, scope)) owned.push(live);
    }
    return owned;
  }

  /** THE answer to which Composio key a call under `scope` uses: the instance's when it provides one, else the scope's; '' when neither. */
  async composioApiKey(scope: PlatformKeyScope, em?: EntityManager): Promise<string> {
    if (this.composioManagedByInstance()) return this.instanceComposio.apiKey;
    return (await this.stored(scope, 'composio_api_key', em)) ?? '';
  }

  /** The webhook secret of the project {@link composioApiKey} opens for `scope`; '' when none. */
  async composioWebhookSecret(scope: PlatformKeyScope): Promise<string> {
    if (this.composioManagedByInstance()) return this.instanceComposio.webhookSecret;
    return (await this.stored(scope, 'composio_webhook_secret')) ?? '';
  }

  /** Which Composio project `scope`'s calls reach, as a cache and work partition: one for the instance's own account, else one per scope. */
  composioPartition(scope: PlatformKeyScope): string {
    if (this.composioManagedByInstance()) return 'instance';
    return scope.kind === 'user' ? `u:${scope.userId}` : `o:${scope.orgId}`;
  }

  /** The Anthropic key this scope stores, or null. */
  anthropicApiKey(scope: PlatformKeyScope): Promise<string | null> {
    return this.stored(scope, 'anthropic_api_key');
  }

  /**
   * Whether this caller may WRITE the scope's keys: their own always, an organization's only
   * as its owner or admin — checked against THAT organization, never "any org".
   */
  async canManage(userId: string, scope: PlatformKeyScope): Promise<boolean> {
    if (scope.kind === 'user') return scope.userId === userId;
    const rows: Array<{ role: string }> = await this.dataSource.query(
      `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [scope.orgId, userId],
    );
    const role = rows[0]?.role;
    return role === 'owner' || role === 'admin';
  }

  private writeIn(scope: PlatformKeyScope, write: (em: EntityManager) => Promise<unknown>): Promise<void> {
    return this.dataSource.transaction(async (em) => {
      if (scope.kind === 'org') await lockOrgForWrite(em, scope.orgId);
      await write(em);
    });
  }

  private owner(scope: PlatformKeyScope): [string | null, string | null] {
    return scope.kind === 'user' ? [scope.userId, null] : [null, scope.orgId];
  }
}
