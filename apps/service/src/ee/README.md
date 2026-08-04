# ee/ — commercial modules

Empty. Everything outside this directory is the open core; this is where commercial modules land
when they exist.

- **The core never imports from here.** The dependency direction is one-way and mechanical: the
  `core-must-not-import-ee` rule in `apps/service/.dependency-cruiser.cjs` fails `pnpm check` if it
  is violated, so the boundary holds by build rather than by convention.
- A commercial module attaches to the core only through a **seam interface the core owns and calls**.
  Exactly one exists today: `EntitlementsProvider` (`src/entitlements/entitlements.ts`) — every limit
  point asks it, and the open-core implementation answers "allowed, unlimited". Adding a seam means
  adding it to the core first; nothing here is wired up yet.
- **Security and correctness are never behind this boundary.**
