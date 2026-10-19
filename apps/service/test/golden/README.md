# Golden legacy histories

Each `<shape>.json` is one run as the build before this one left it at a crash: its rows in the app
database and in the DBOS system database, verbatim. `test/support/golden-history.ts` restores one under
a new run id, with every time in it moved forward by its age, and `test/recovery-guard.e2e-spec.ts`
recovers each one on this build.

Recorded from `4bd5caa9b5823584f5bc148e0bb1a96604c7ad4d`, the last engine change before the recovery
guard, run from `apps/service`:

```bash
pnpm golden:record 4bd5caa9b5823584f5bc148e0bb1a96604c7ad4d
```

The recorder unpacks that commit from this clone's history, boots it on a throwaway database per shape,
drives the run to its crash point, kills it and dumps the rows. Add shape names after the sha to record
only those. Every history must come from one build: record them all again when that build changes.
