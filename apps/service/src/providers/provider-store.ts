/**
 * The persistent KV store a trigger owns (polling/dedup cursors). One instance per trigger row, threaded
 * through enable → every poll → disable; the trigger layer supplies the DB-backed implementation.
 */
export interface ProviderStore {
  get<T = unknown>(key: string): Promise<T | null>;
  put<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<void>;
}

/** Ephemeral, per-invocation store. Fine for stateless actions/tests; NOT persistent. */
export class InMemoryStore implements ProviderStore {
  private readonly mem = new Map<string, unknown>();
  get<T = unknown>(key: string): Promise<T | null> {
    return Promise.resolve((this.mem.get(key) as T | undefined) ?? null);
  }
  put<T = unknown>(key: string, value: T): Promise<T> {
    this.mem.set(key, value);
    return Promise.resolve(value);
  }
  delete(key: string): Promise<void> {
    this.mem.delete(key);
    return Promise.resolve();
  }
}
