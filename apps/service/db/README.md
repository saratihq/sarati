# Database schema

Two files answer two different questions.

| | What it is | Applied by |
|---|---|---|
| `schema.sql` | The current schema, whole. A `pg_dump` of a database that is up to date. | `pnpm db:init` — refuses to run against a database that already has a `users` table, so it can never clobber data |
| `migrations/*.sql` | Numbered steps that bring an **older** database forward. | `pnpm db:migrate` |

Both commands read `DATABASE_URL` from `apps/service/.env` or the environment, and both run from
`apps/service`:

```bash
pnpm --dir apps/service db:init      # fresh database
pnpm --dir apps/service db:migrate   # existing database, after a pull
```

From the repo root, `pnpm db:init` and `pnpm db:migrate` forward to the same scripts. The container
entrypoint runs both on every boot.

## The rule every migration must keep

**There is no ledger table.** `db:migrate` re-applies *every* file in `migrations/` on *every* run,
in filename order. So each statement must be safe to run again: `IF NOT EXISTS`, `DROP … IF EXISTS`,
`ON CONFLICT DO NOTHING`, or a `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL $$` guard around
an `ADD CONSTRAINT` (which has no `IF NOT EXISTS` form).

A migration must also stay **convergent**, not just re-runnable: after an earlier file recreates a
row a later file renamed, re-running the chain has to end in the same state. Where that is subtle —
the `prod` → `production` rename, the dropped legacy trigger tables — the file says so in a comment.

A new migration is numbered next in sequence and its result is folded into `schema.sql` (re-dump, or
hand-apply the same DDL) so a fresh install and a migrated install agree.
