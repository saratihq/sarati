import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';
import { DomainError } from '../common/domain-error';

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

/** Who a key belongs to. A key is owned by a user or by an organization, never by the instance. */
export type PlatformKeyScope = { kind: 'user'; userId: string } | { kind: 'org'; orgId: string };

/** Presence of a key in a scope; the value itself is never part of this. */
export interface PlatformKeyState {
  present: boolean;
  updated_at: string | null;
}

/**
 * Store for the two optional platform API keys, Fernet-encrypted at rest through the same
 * path as connection credentials. Read per call, never snapshotted, so a key entered in
 * Settings takes effect without a restart.
 */
@Injectable()
export class PlatformKeysService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

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

  /** Upsert the key for this scope. Encrypted at rest; never read back over the API. */
  async set(scope: PlatformKeyScope, name: PlatformKeyName, plaintext: string): Promise<void> {
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
    await this.dataSource.query(
      `INSERT INTO platform_secrets (name, user_id, org_id, secret) VALUES ($1, $2, $3, $4)
       ON CONFLICT ${target}
       DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`,
      [name, ...this.owner(scope), enc],
    );
  }

  /** Remove this scope's key; returns true if one was stored. */
  async clear(scope: PlatformKeyScope, name: PlatformKeyName): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `DELETE FROM platform_secrets
        WHERE name = $1 AND user_id IS NOT DISTINCT FROM $2 AND org_id IS NOT DISTINCT FROM $3
        RETURNING id`,
      [name, ...this.owner(scope)],
    );
    return rows.length > 0;
  }

  /** Which keys this scope has, and when each was last written — never the values themselves. */
  async presence(scope: PlatformKeyScope): Promise<Record<PlatformKeyName, PlatformKeyState>> {
    const rows: Array<{ name: string; updated_at: Date }> = await this.dataSource.query(
      `SELECT name, updated_at FROM platform_secrets
        WHERE user_id IS NOT DISTINCT FROM $1 AND org_id IS NOT DISTINCT FROM $2`,
      this.owner(scope),
    );
    const byName = new Map(rows.map((r) => [r.name, r.updated_at]));
    return Object.fromEntries(
      PLATFORM_KEY_NAMES.map((name) => {
        const at = byName.get(name);
        return [name, { present: at !== undefined, updated_at: at ? at.toISOString() : null }];
      }),
    ) as Record<PlatformKeyName, PlatformKeyState>;
  }

  /** The decrypted key for this scope, or null when unset. */
  async get(scope: PlatformKeyScope, name: PlatformKeyName): Promise<string | null> {
    const rows: Array<{ secret: string }> = await this.dataSource.query(
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
    if (!row) return null;
    // Through `scopeFor`, so a workflow sitting in a PERSONAL org resolves to its user exactly
    // as the same person's requests do — one rule, or a key set in the UI is never found here.
    if (row.user_id) return this.scopeFor(row.user_id, row.org_id);
    return row.org_id ? { kind: 'org', orgId: row.org_id } : null;
  }

  /** Live Composio subscriptions this scope owns — what a credential change leaves stranded. */
  async liveComposioSubscriptions(
    scope: PlatformKeyScope,
  ): Promise<Array<{ workflowName: string; triggerType: string }>> {
    // Ownership must be read the same way `scopeForWorkflow` reads it: an org workflow also
    // carries its creator's user_id, so org_id decides first.
    const owned = scope.kind === 'org' ? `w.org_id = $1` : `w.org_id IS NULL AND w.user_id = $1`;
    const id = scope.kind === 'org' ? scope.orgId : scope.userId;
    return this.dataSource.query(
      `SELECT w.name AS "workflowName", a.trigger_type AS "triggerType"
         FROM runtime_trigger_activations a
         JOIN workflows w ON w.id = a.workflow_id
        WHERE a.composio_trigger_instance_id IS NOT NULL AND a.paused = false AND ${owned}`,
      [id],
    );
  }

  /** The Composio key as the empty-string sentinel the managed rail tests for. */
  async composioApiKey(scope: PlatformKeyScope): Promise<string> {
    return (await this.get(scope, 'composio_api_key')) ?? '';
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

  private owner(scope: PlatformKeyScope): [string | null, string | null] {
    return scope.kind === 'user' ? [scope.userId, null] : [null, scope.orgId];
  }
}
