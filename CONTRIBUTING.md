# Contributing

For anyone changing this codebase — human engineers and coding agents alike. The operating rules
live in [AGENTS.md](AGENTS.md); this file is how to get it running and how to get a change merged.

## The pieces

One pnpm workspace. Unless a command says otherwise, run it from the **repo root**.

| Package | Runs on | What it is |
|---|---|---|
| `@sarati/service` (`apps/service`) | `:8001` | NestJS API + the execution engine. Owns its Postgres schema. |
| `@sarati/client` (`apps/client`) | `:3100` | Next.js UI. |
| `@sarati/agent` (`apps/agent`) | `:8010` | The AI composer. Optional — the editor is fully usable without it. |
| `sarati-mcp` (`apps/service/packages/mcp-bridge`) | stdio | Published bridge letting stdio-only MCP clients reach `/mcp`. MIT, unlike the rest. |

[`@sarati/actions-sdk`](https://www.npmjs.com/package/@sarati/actions-sdk) lives in its own
repository: it is published standalone and deliberately independent of this platform.

## Getting set up

You need **Node 24** (see `.nvmrc`), **pnpm**, and **PostgreSQL 16+**.

### 1. Install, and copy the env files

```bash
pnpm install                      # installs every package in the workspace
cp apps/client/.env.example apps/client/.env.local
cp apps/service/.env.example apps/service/.env
```

Copy those env files before anything else. `NEXT_PUBLIC_*` values are inlined by `next build`, so the
client **refuses to build** without them rather than silently baking in a dev host — a fresh clone
fails the gate until they exist, and the error tells you so.

### 2. Create the database role and the database

`apps/service/.env.example` ships
`DATABASE_URL=postgresql://orchestr:orchestr@localhost:5432/orchestr_svc`, so create exactly that
role and that database:

```bash
createuser --createdb --pwprompt orchestr   # password: orchestr, unless you edit .env to match
createdb --owner=orchestr orchestr_svc
```

The role name is not cosmetic: `apps/service/db/schema.sql` assigns ownership to `orchestr`, so
`db:init` fails against a database whose owner role does not exist. Using different credentials means
changing `DATABASE_URL` in `apps/service/.env` **and** the two commands above to match.

### 3. Create the schema

```bash
pnpm db:init                      # fresh database — creates the current schema
```

`db:init` and `db:migrate` read `DATABASE_URL` from `apps/service/.env` when it isn't already in the
environment, so this works straight after step 1 with nothing exported.

Already have a database? `pnpm db:migrate` instead of `db:init` — migrations bring an existing
schema forward, and the service **refuses to boot on a stale schema** rather than corrupting it. If
it exits at startup complaining the schema is out of date, that guard is working: migrate and retry.
[`apps/service/db/README.md`](apps/service/db/README.md) explains how the two differ and the rule
every migration has to keep.

### 4. Run it

Two terminals, both from the repo root:

```bash
pnpm --filter @sarati/service build && node apps/service/dist/main.js   # the API, on :8001
pnpm dev                                                               # the UI, on :3100
```

Run the service from `dist`. A watch-mode or stale process happily serves old code and will waste an
afternoon.

Then open <http://localhost:3100> and create the first account.

### Containers

Every image builds from the **workspace root**, because the lockfile lives there and a package cannot
resolve its dependencies alone:

```bash
docker build -f apps/service/Dockerfile -t sarati/service .
```

## After pulling main

```bash
pnpm install      # a missing module surfaces as ghost "unsafe type" lint errors, not a clear failure
pnpm db:migrate   # idempotent
```

In the client, if the dev server reports "Module not found" for a dependency that *is* installed,
`rm -rf .next` — Turbopack caches module-resolution failures across restarts.

## The gate

```bash
pnpm check    # every package: lint, format, types, the open-core boundary, unit and e2e
```

One command is the whole gate, and it is the same command CI is configured to run. **Run it green
yourself before every merge** — locally is where a failure is cheap to read, and a green check on a
branch you never ran is not evidence.

Run it from the root, so it covers all three apps rather than the one you happen to be standing in.
In the client that means `lint` and unit tests plus a production `build`, since the Next build is a
strict type-check as well as a compile. Working on one app, `pnpm --filter @sarati/service check`
narrows it, but the root run is the gate.

The service's e2e suite talks to the Postgres database from step 2 — it has to be up.

## The vault

Every load-bearing invariant has one definition site and a named guarding test, enforced by
`apps/service/test/invariants.e2e-spec.ts` and the `moat-*` dependency-cruiser rules.
[`apps/service/src/domain/README.md`](apps/service/src/domain/README.md) is the constitution: every
rule, where it is defined, and the test that fails when it breaks.

If your change touches `src/ir`, `src/compiler`, `src/workflows` or `src/environments`, that suite
must stay green. **A red invariant test means the change is wrong, or it ships as a deliberate
amendment that says so — never edit the test to make it pass.** Don't re-declare a vault constant
locally, and never compare workflow documents byte-wise: `computeDiff` on the server and
`irContentKey` on the client are the only answers to "did the content change?".

## Before you open a PR

- [ ] `pnpm check` green end to end — no "pre-existing" excuses. If `main` is red, fix it.
- [ ] Zero lint issues, errors *and* warnings, fixed rather than suppressed.
- [ ] No `any` on public surfaces; narrow at I/O boundaries only.
- [ ] `depcruise` passes — the open-core boundary holds, core never imports `apps/service/src/ee`.
- [ ] A behaviour change carries a **live** test, not a unit mock.
- [ ] Verified by actually running it, not by watching it compile.

## Commits and PRs

Prefix is exactly one of `feat` / `chore` / `fix` (optional scope). Everything else — `test`, `docs`,
`refactor` — maps onto `chore`. The subject is one line, no body; `Co-Authored-By:` is the only
allowed footer. One branch at a time, and delete it on merge.

## The open-core boundary

Everything outside `apps/service/src/ee/` is the open core. The dependency direction is one-way and
mechanical: core never imports from `ee`, and the `core-must-not-import-ee` rule in
`apps/service/.dependency-cruiser.cjs` fails `pnpm check` if it does. Security and correctness never
live behind that boundary.

## Reporting a security problem

Don't open a public issue — [SECURITY.md](SECURITY.md) has the private disclosure route.

By contributing you agree your contribution is licensed under the same terms as the project — see
[LICENSE.md](LICENSE.md).
