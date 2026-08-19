import type { DataSource } from 'typeorm';

import { rawQuery } from '../database/raw-query';
import type { ProviderStore } from '../providers/provider-store';

/**
 * The persistent KV (ProviderStore) for ONE trigger activation — cursors, webhook
 * secret, subscription handle. Single-writer by construction (reconciler + poll sweep are both
 * pg-boss singletons), so per-key upsert atomicity suffices.
 */
export class DbActivationStore implements ProviderStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly activationId: string,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await rawQuery<{ value: T | null }>(
      this.dataSource.manager,
      `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = $2`,
      [this.activationId, key],
    );
    return rows[0]?.value ?? null;
  }

  async put<T = unknown>(key: string, value: T): Promise<T> {
    await this.dataSource.query(
      `INSERT INTO runtime_activation_store (activation_id, key, value)
       VALUES ($1, $2, CAST($3 AS json))
       ON CONFLICT (activation_id, key) DO UPDATE SET value = CAST($3 AS json)`,
      [this.activationId, key, JSON.stringify(value ?? null)],
    );
    return value;
  }

  async delete(key: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM runtime_activation_store WHERE activation_id = $1 AND key = $2`,
      [this.activationId, key],
    );
  }
}
