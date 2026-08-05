# Sarati

**Version control for your automations.** Branch a workflow, review the diff, merge it, promote it
through environments — then run it durably on the built-in engine.

Automations get edited in place. Someone tweaks a live workflow on Friday, it misfires on Sunday, and
there is no diff to read and nothing to roll back to. That is survivable while the workflow is a
convenience, and not once it moves money, messages customers or runs payroll.

Sarati treats a workflow the way you already treat code.

<!-- BEFORE PUBLIC: the install below is verified working end to end against locally-built images.
     Two things still have to be true for a stranger: the images must be pushed to GHCR, and
     get.sarati.io must serve install.sh. Until both are done, this command fails for everyone
     but us. -->

## Quickstart

```bash
curl -fsSL https://get.sarati.io | bash
```

Then open <http://localhost:8080> and create your account. The first account is the owner; everyone
after joins by invite.

Prefer to read what you're about to run? The installer only fetches the compose file, generates this
install's secrets, and starts it — so you can do the same by hand:

```bash
curl -fsSL https://raw.githubusercontent.com/saratihq/sarati/main/docker-compose.yaml -o docker-compose.yaml
curl -fsSL https://raw.githubusercontent.com/saratihq/sarati/main/.env.example -o .env   # then fill in the three secrets
docker compose up -d
```

Docker is the only requirement. Postgres, the engine, the UI and a reverse proxy come up together
behind a single port, so it works the same on your laptop, a VPS, or behind your own domain. Point
`SARATI_URL` at wherever it actually lives and nothing else changes.

Re-running the installer is safe — it never overwrites an existing `.env`, so upgrades keep your keys
and your data.

## What makes it different

**Real version control, not an audit log.** Branches carry their own version numbers. Changes diff
and merge at the **field level inside a node** — not as text — so two people editing different
settings on the same step reconcile cleanly instead of conflicting. Renames keep a node's identity
rather than showing up as an add plus a delete.

**Reviews before things go live.** Open a review on a branch, see exactly what changed, merge when
it's approved. Promotion moves an environment pointer — staging, uat, production — so shipping is a
pointer move, not a copy-paste.

**Runs that survive a restart.** Execution is durable: if a worker crashes or you redeploy
mid-flight, runs resume instead of being orphaned.

**Built for agents, not just people.** Fifteen MCP tools let an AI agent read your workflows, open a
branch, propose an edit and run a dry test — through the same review gate a human goes through, and
without the authority to merge or promote. Any workflow you publish also becomes a tool an agent can
call.

**AI that produces reviewable output.** Describe what you want and the composer drafts it on the
canvas. What it produces is ordinary versioned workflow structure — diffable, mergeable, reviewable —
not an opaque blob you have to trust. The AI agent node works the same way: its configuration is
first-class, so a prompt change shows up in a diff like anything else.

**Connections that belong to the environment.** A step declares which app it needs; the environment
supplies the account. Staging hits the sandbox, production hits the real thing, and sharing a
workflow never shares a credential. Connect in one click, or bring your own OAuth app or API key.
Stored credentials are encrypted at rest and never returned over the API.

## Editions

Sarati is open-core: what you self-host is the whole product, and commercial modules live behind a
boundary the build enforces — the core is not allowed to import from them, and a dependency-cruiser
rule fails `pnpm check` if it ever does, so the boundary holds mechanically rather than by
convention. **Security and correctness are never behind that boundary.** The managed cloud exists
because someone has to run and pay for infrastructure, not because the safe version costs money.

Licensed [fair-code](https://faircode.io) under the Sarati Sustainable Use License — source-available
and free to self-host, with limits on reselling it as a competing service. See
[LICENSE.md](LICENSE.md).

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — running it locally, the test gate, how to send a change
- [AGENTS.md](AGENTS.md) — the operating rules, for humans and coding agents alike
- [SECURITY.md](SECURITY.md) — how to report a vulnerability privately
- [`apps/service/src/domain/README.md`](apps/service/src/domain/README.md) — the domain invariants
  and the test that guards each one

## Related

- [`@sarati/actions-sdk`](https://www.npmjs.com/package/@sarati/actions-sdk) — write your own typed
  actions and triggers. MIT, and deliberately independent of this platform.
