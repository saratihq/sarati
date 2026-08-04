import type { EntityManager } from 'typeorm';

/** The ONE quarantined any→T boundary for raw SQL — callers declare the row shape. */
export async function rawQuery<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T[]> {
  return em.query(sql, params);
}

/** Raw UPDATE/DELETE returning the affected-row count (the pg driver returns `[rows, affected]`). */
export async function rawMutate(em: EntityManager, sql: string, params: unknown[] = []): Promise<number> {
  const [, affected]: [unknown[], number | null] = await em.query(sql, params);
  return affected ?? 0;
}

/** JSON-serialize any value into a plain Record. */
export function jsonRecord(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return JSON.parse(JSON.stringify(value));
}
