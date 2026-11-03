# ee/ — commercial modules

Empty. Everything outside this directory is the open core; this is where commercial modules land
when they exist.

- **The core never imports from here.** The dependency direction is one-way and mechanical: the
  `core-must-not-import-ee` rule in `apps/service/.dependency-cruiser.cjs` fails `pnpm check` if it
  is violated, so the boundary holds by build rather than by convention.
- A commercial module attaches to the core only through a **seam interface the core owns and calls**.
  Exactly one exists today: `EntitlementsProvider` (`src/entitlements/entitlements.ts`), and it covers
  the run budget's five numbers (`src/entitlements/run-limits.ts`, constitution row 26) and nothing
  else yet — `decideRunLimits` is its one caller, and nothing calls `allows`. The open-core
  implementation answers each run limit from its operator variable, for any workspace, every other
  metric "unlimited" and every feature "allowed"; a provider here may answer a workspace's run limits
  from its plan instead, with no core change. Other limits read their operator variable or a constant
  and never ask it: the instance Composio account's monthly app actions per person
  (`INSTANCE_COMPOSIO_MONTHLY_ACTIONS_PER_PERSON`) and an MCP caller's live runs an hour
  (`LIVE_RUNS_PER_HOUR`). Adding a seam, or bringing another limit under this one, means changing the
  core first; nothing here is wired up yet.
- **Security and correctness are never behind this boundary.**
