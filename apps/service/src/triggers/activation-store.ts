import type { DataSource } from 'typeorm';

import { newId } from '../database/ids';
import { rawQuery } from '../database/raw-query';
import type { ProviderStore } from '../providers/provider-store';

/** The store key of the epoch an activation's trigger runs are named under; a reset, which empties the store, drops it. */
export const ADMISSION_EPOCH_KEY = 'admission.epoch';

/** One trigger activation's persistent KV; its lock serialises the reconciler against a poll, while the webhook intake writes its dedupe key, and mints a missing epoch, unlocked. */
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

  async clear(): Promise<void> {
    await this.dataSource.query(`DELETE FROM runtime_activation_store WHERE activation_id = $1`, [
      this.activationId,
    ]);
  }

  /** The activation's admission epoch, one minted when there is none; of two callers minting at once, both read the first one written. */
  async admissionEpoch(): Promise<string> {
    const epoch = await this.get<string>(ADMISSION_EPOCH_KEY);
    if (epoch) return epoch;
    await this.dataSource.query(
      `INSERT INTO runtime_activation_store (activation_id, key, value)
       VALUES ($1, $2, CAST($3 AS json))
       ON CONFLICT (activation_id, key) DO NOTHING`,
      [this.activationId, ADMISSION_EPOCH_KEY, JSON.stringify(newId())],
    );
    const minted = await this.get<string>(ADMISSION_EPOCH_KEY);
    if (!minted)
      throw new Error(`activation ${this.activationId} was set up again while its epoch was minted`);
    return minted;
  }
}

/** A store whose writes are read back at once but reach `store` only on `commit`. */
export class HeldWritesStore implements ProviderStore {
  private readonly held = new Map<string, { value: unknown } | null>();

  constructor(private readonly store: ProviderStore) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const held = this.held.get(key);
    if (held === undefined) return this.store.get<T>(key);
    return held === null ? null : (held.value as T);
  }

  put<T = unknown>(key: string, value: T): Promise<T> {
    this.held.set(key, { value });
    return Promise.resolve(value);
  }

  delete(key: string): Promise<void> {
    this.held.set(key, null);
    return Promise.resolve();
  }

  async commit(): Promise<void> {
    for (const [key, held] of this.held) {
      if (held === null) await this.store.delete(key);
      else await this.store.put(key, held.value);
    }
    this.held.clear();
  }
}
