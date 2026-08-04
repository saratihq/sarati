# Working in this repo

Sarati is a build-and-run automation platform whose differentiator is **native version control for
workflows** — branching, three-way merge, reviews, environment promotion — on its own execution
engine. Steps run on exactly two rails: the first-party Actions SDK (in-process) and Composio
(managed-auth broker).

## Source of truth

The code always wins. Never state what is built, done or remaining from a document or from memory —
read the current code first, and say so plainly when something written disagrees with it rather than
following either silently.

## The vault — invariants that must survive

Every load-bearing invariant has **one definition site** and a **named guarding test**, enforced by
`apps/service/test/invariants.e2e-spec.ts` and the `moat-*` dependency-cruiser rules.

Before touching `src/ir`, `src/compiler`, `src/workflows` or `src/environments` (all under
`apps/service/`): read the constitution,
[`apps/service/src/domain/README.md`](apps/service/src/domain/README.md). Never re-declare a vault
constant, and never re-answer "did the content change?" locally — the server's answer is
`computeDiff`, the client's is `irContentKey`.

**A red invariant test means the change is wrong, or it is deliberately amending the constitution and
has to say so. Never edit the test to make it pass.**

## How to work

- Discuss before building. Implement incrementally. Test every scenario before moving on.
- Nothing is done until it is **live-verified end to end** against the real thing — not compiled, not
  unit-mocked. Report per-item proof honestly; fewer and real beats many and assumed.
- Fix every lint, type and test error you touch. "Pre-existing" is not an excuse.
- One branch at a time; bundle related work into a single verified commit.
- Config burden lives in adapter code, never in user-facing configuration.
- Never recommend a patch, workaround or limitation where a correct fix exists.

## Comments: default to NONE

Only where the code cannot say it itself — a non-obvious constraint, an invariant reference,
fail-open vs fail-closed — and then **one line**. No rationale essays, no history, no restating the
code, no owner or date stamps. Reasoning belongs in the pull request, not in a comment. JSDoc only on
exported symbols and type fields, one line each.

## Persisted identifiers

These strings are written into saved data, issued tokens, live cookies or the database itself.
**Renaming one is a data migration — never a find-and-replace, and never part of a rebrand.**

- Node types (`orchestr:agent`, `orchestr:code`, `orchestr:if`, …) and the `orchestr_actions`
  catalog — in every saved workflow document.
- The `orchestr:local` session issuer — in every issued local-session token.
- The `orchestr_local_session` cookie and the `orchestr-oauth` `postMessage` type — renaming either
  signs users out or breaks the connect popup mid-flight.
- The `--orchestr-*` CSS custom properties — the client's token names.
- The `orchestr_svc` database name.

The user-visible product name is Sarati and is free to change; none of the above is user-visible.

## Working on the UI

One primary action per screen; real loading, empty and error states, not just the happy path;
keyboard-accessible; match existing tokens — `apps/client/src/app/globals.css` is the token source,
and a token that is not in it does not exist.

Next.js here has breaking changes from what you remember: read the relevant guide in
`node_modules/next/dist/docs/` before writing framework code.

**JSX copy gotcha (swc #11568, unfixed in Next 16.2.x):** in a multi-line JSX text run containing an
HTML entity (`&apos;`, `&rarr;`, …), SWC drops a same-line boundary space after an inline element or
expression — `…{provider} account…` renders as `claudeaccount`. Write those boundaries as an explicit
`{" "}`, and check suspect copy in the rendered DOM rather than by eye.

## The gate

**You are the gate.** `pnpm check` (lint + format + typecheck + depcruise + test + e2e) green from
the repo root before every merge — the same command CI is configured to run, so a branch you never
ran green is unverified whatever a check mark says. If `main` is red, fix it, don't inherit it.

Sonar-level hygiene: low complexity, no duplication, no dead code, no swallowed errors. A behaviour
change carries a live test, not a unit mock.

The service's e2e suite needs its Postgres up; setup is in
[CONTRIBUTING.md](CONTRIBUTING.md#getting-set-up).

Running the e2e suite from a git worktree collects **zero** tests and exits 1, because
`apps/service/test/jest-e2e.json` ignores `/.claude/` to stop the main checkout collecting worktree
copies. From a worktree, inside `apps/service`:
`pnpm exec jest --config test/jest-e2e.json --testPathIgnorePatterns=/node_modules/`.

## Commits

Prefix is exactly one of `feat` / `chore` / `fix` (optional scope); everything else — `test`, `docs`,
`refactor` — maps onto `chore`. Subject is **one line**, no body. The `Co-Authored-By:` trailer is
the only allowed footer. Delete the branch on merge.
