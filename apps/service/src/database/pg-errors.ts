const PG_UNIQUE_VIOLATION = '23505';

/** Whether `err` is Postgres refusing a write that would break a unique constraint. */
export function isUniqueViolation(err: unknown): boolean {
  const e = (err ?? {}) as { driverError?: { code?: string }; code?: string };
  return e.driverError?.code === PG_UNIQUE_VIOLATION || e.code === PG_UNIQUE_VIOLATION;
}
