# Golden legacy histories

Each `<build>/<shape>.json` is one run as the build at commit `<build>` left it at a crash: its rows in
the app database and in the DBOS system database, verbatim. A run that build resumes may also carry
its `outcome`: what that build made of the run when it recovered, driven as
`test/support/golden-outcome.ts` drives it. `test/support/golden-history.ts` restores a history under a
new run id, with every time in it moved forward by its age.

- `0af0a76` is v0.2.23, the release before the recovery guard. Its waits park on the run's row, not
  their steps, and two waits on one topic share a receive, so it has no `shared-receive-*` shapes: its
  `inside-wait-fan-out` is that shape.
- `bdf9cd7` is v0.2.24, the release that added the recovery guard, and the build before this one
  (`PREVIOUS_BUILD`).

They are recovered on this build by:

- `test/golden-recovery.e2e-spec.ts`, over `PREVIOUS_BUILD`: a history with an `outcome` must come to
  the same outcome, and any other is ended by the recovery guard;
- `test/recovery-guard.e2e-spec.ts`, over both builds, after migrating the database as an upgrade does,
  under the guard's own checks.

`test/rollback-to-earlier-build.e2e-spec.ts` boots `PREVIOUS_BUILD`.

Record a build's histories from `apps/service`, all shapes or those named after the sha:

```bash
pnpm golden:record 0af0a76fa9e5419accca5f3e46415fc990ddeda3 linear-parked parked-before-fan-out inside-step-fan-out inside-wait-fan-out inside-timer-fan-out parked-after-fan-out agent-tool-calls pins
```

```bash
pnpm golden:record bdf9cd749b85af69992166e976f613e77e030088
```

The recorder unpacks that commit from this clone's history, boots it on a throwaway database built
from its own `db/schema.sql`, per shape, drives the run to its crash point, kills it and dumps the
rows into `<build>/`. For a run it resumes, it restores the dump on a fresh database of that schema,
recovers and drives it, and stores the outcome. Every history in one directory comes from one build:
record them all again when that build changes.
