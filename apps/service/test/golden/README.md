# Golden legacy histories

Each `<build>/<shape>.json` is one run as the build at commit `<build>` left it at a crash: its rows in
the app database and in the DBOS system database, verbatim. `test/support/golden-history.ts` restores
one under a new run id, with every time in it moved forward by its age, and
`test/recovery-guard.e2e-spec.ts` migrates the database as an upgrade does and recovers each one on
this build.

- `0af0a76` is v0.2.23, the release before the recovery guard. Its waits park on the run's row, not
  their steps, and two waits on one topic share a receive, so it has no `shared-receive-wait-fan-out`:
  its `inside-wait-fan-out` is that shape.
- `4bd5caa` is the last engine change before the guard, on `main` after v0.2.23.

Record a build's histories from `apps/service`, all shapes or those named after the sha:

```bash
pnpm golden:record 0af0a76fa9e5419accca5f3e46415fc990ddeda3 linear-parked parked-before-fan-out inside-step-fan-out inside-wait-fan-out inside-timer-fan-out parked-after-fan-out agent-tool-calls pins
```

```bash
pnpm golden:record 4bd5caa9b5823584f5bc148e0bb1a96604c7ad4d
```

The recorder unpacks that commit from this clone's history, boots it on a throwaway database built
from its own `db/schema.sql`, per shape, drives the run to its crash point, kills it and dumps the
rows into `<build>/`. Every history in one directory comes from one build: record them all again when
that build changes.
