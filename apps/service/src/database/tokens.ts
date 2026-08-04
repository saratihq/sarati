/** DI token for the raw pg Pool — kept in its own module so providers avoid a circular import. */
export const PG_POOL = Symbol('PG_POOL');
