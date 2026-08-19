import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, IsNull } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { GRANTABLE_SCOPES, NON_GRANTABLE_SCOPE, isApiScope } from '../auth/scopes';
import { newId, now } from '../database/ids';
import { ApiKeyEntity } from '../database/entities/api-key.entity';

const PREFIX = 'ork_'; // Sarati key

export interface IssuedKey {
  id: string;
  name: string;
  /** Plaintext key — shown ONCE, at creation. Never stored. */
  key: string;
  prefix: string;
  created_at: string | null;
}

/** SHA-256 of the plaintext (stored); lookups hash the presented key and compare. */
function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Programmatic access: only the hash is stored — the plaintext exists once. */
@Injectable()
export class ApiKeysService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async issue(
    userId: string,
    orgId: string | null,
    name: string,
    scopes: string[] | null,
  ): Promise<IssuedKey> {
    // A stored `null` means full authority; only legacy rows carry it and no new key may.
    const requested = scopes && scopes.length > 0 ? [...new Set(scopes)] : null;
    if (!requested) {
      throw new DomainError(
        `Choose what this key may do — an API key must name its scopes. Valid scopes: ${GRANTABLE_SCOPES.join(', ')}.`,
        400,
      );
    }
    const unknown = requested.filter((s) => !isApiScope(s));
    if (unknown.length > 0) {
      throw new DomainError(
        `Unknown scope(s): ${unknown.join(', ')}. Valid scopes: ${GRANTABLE_SCOPES.join(', ')}.`,
        400,
      );
    }
    if (requested.includes(NON_GRANTABLE_SCOPE)) {
      throw new DomainError(
        `The "${NON_GRANTABLE_SCOPE}" scope cannot be granted to an API key — a key that issues keys can issue an unscoped one. Manage keys from a signed-in session.`,
        400,
      );
    }

    const secret = randomBytes(24).toString('base64url');
    const plaintext = `${PREFIX}${secret}`;
    const prefix = plaintext.slice(0, 12);

    const row = this.dataSource.manager.create(ApiKeyEntity, {
      id: newId(),
      userId,
      orgId,
      name,
      keyHash: hashKey(plaintext),
      prefix,
      scopes: requested,
      createdAt: now(),
    });
    await this.dataSource.manager.save(ApiKeyEntity, row);

    return { id: row.id, name, key: plaintext, prefix, created_at: row.createdAt?.toISOString() ?? null };
  }

  async list(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.dataSource.manager.find(ApiKeyEntity, {
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      last_used_at: r.lastUsedAt?.toISOString() ?? null,
      expires_at: r.expiresAt?.toISOString() ?? null,
      revoked_at: r.revokedAt?.toISOString() ?? null,
      created_at: r.createdAt?.toISOString() ?? null,
    }));
  }

  async revoke(userId: string, keyId: string): Promise<void> {
    // Ownership in the WHERE, not load-then-save, so it can't race a concurrent verify() write.
    const res = await this.dataSource.manager.update(
      ApiKeyEntity,
      { id: keyId, userId },
      { revokedAt: now() },
    );
    if (!res.affected) throw new DomainError('API key not found', 404);
  }

  /** Verify a key → owner, scopes, and issuing org. All three are needed to limit it. */
  async verify(
    plaintext: string,
  ): Promise<{ userId: string; scopes: string[] | null; orgId: string | null } | null> {
    if (!plaintext.startsWith(PREFIX)) return null;
    const row = await this.dataSource.manager.findOne(ApiKeyEntity, {
      where: { keyHash: hashKey(plaintext) },
    });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    // Stamp last_used_at only while un-revoked: a revoke racing the read makes affected 0, and we reject.
    const res = await this.dataSource.manager.update(
      ApiKeyEntity,
      { id: row.id, revokedAt: IsNull() },
      { lastUsedAt: now() },
    );
    if (!res.affected) return null;
    return { userId: row.userId, scopes: row.scopes, orgId: row.orgId ?? null };
  }
}
