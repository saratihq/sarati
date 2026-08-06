# Sarati

Build automations on a canvas. Branch, review and merge them like code. Run them on an engine that
survives a restart.

Most automation tools make you choose. Visual builders are quick to start and impossible to govern —
one shared canvas, edited live, no diff, no rollback. Durable engines are dependable and code-only, so
nobody outside engineering can touch them. Sarati is both: a visual builder whose every change is
versioned, reviewable and promotable, on a first-party durable runtime.

## Quickstart

```bash
curl -fsSL https://get.sarati.io | sh
```

Open <http://localhost:8080> and create your account. The first account is the owner; everyone after
joins by invite. Docker is the only requirement — Postgres, the engine, the UI and a reverse proxy come
up behind one port, so a laptop, a VPS and your own domain all work the same way. Re-running the
installer keeps your keys and your data.

Prefer to read before you run it? The installer only fetches the compose file, generates this install's
secrets, and starts it:

```bash
curl -fsSL https://raw.githubusercontent.com/saratihq/sarati/main/docker-compose.yaml -o docker-compose.yaml
curl -fsSL https://raw.githubusercontent.com/saratihq/sarati/main/.env.example -o .env   # fill in three secrets
docker compose up -d
```

## What you get

**A canvas that produces reviewable structure.** Drag steps, wire ports, write code in a sandboxed
node. Every save is a version on a branch — never an edit to what is live.

**Version control that understands workflows.** Branches carry their own version numbers. Changes diff
and merge at the **field level inside a step**, not as text, so two people editing different settings on
the same step reconcile cleanly. Renaming a step keeps its identity instead of reading as a delete plus
an add.

**Reviews and environments.** Open a review on a branch, see exactly what changed, merge when it is
approved. A protected branch takes change only that way. Promotion moves an environment pointer —
staging, uat, production — so shipping is a pointer move, not a copy-paste.

**Runs that survive a restart.** Execution is durable. If a worker crashes or you redeploy mid-flight,
runs resume instead of being orphaned.

**Connections that belong to the environment.** A step declares which app it needs; the environment
supplies the account. Staging hits the sandbox, production hits the real thing, and sharing a workflow
never shares a credential. Connect in one click, or bring your own OAuth app or API key. Stored
credentials are encrypted at rest and never returned over the API.

**AI that is answerable to the same rules.** Describe what you want and the composer drafts it on the
canvas; what it produces is ordinary versioned structure, diffable and reviewable. The AI agent step is
configured in the open, so a prompt change shows up in a diff like any other change.

**Agents work through the review gate, not around it.** MCP tools let an agent read your workflows, open
a branch, propose an edit and run a dry test — with no authority to merge or promote. A workflow becomes
callable by an agent only when you give it a "Callable by an agent" trigger and publish it.

## Editions

What you self-host is the whole product. Commercial modules live behind a boundary the build enforces:
the core may not import from them, and a dependency-cruiser rule fails `pnpm check` if it ever does.
**Security and correctness are never behind that boundary.**

Licensed [fair-code](https://faircode.io) under the Sarati Sustainable Use License — source-available,
free to self-host, with limits on reselling it as a competing service. See [LICENSE.md](LICENSE.md).

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — running it locally, the test gate, sending a change
- [SECURITY.md](SECURITY.md) — reporting a vulnerability privately
- [AGENTS.md](AGENTS.md) — the working rules, for humans and coding agents alike
- [`apps/service/src/domain/README.md`](apps/service/src/domain/README.md) — the invariants and the test
  guarding each one

## Related

- [`@sarati/actions-sdk`](https://www.npmjs.com/package/@sarati/actions-sdk) — write your own typed
  actions and triggers. MIT, and independent of this platform.
