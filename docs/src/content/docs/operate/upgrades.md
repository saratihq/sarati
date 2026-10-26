---
title: Upgrades and backups
description: Move to a new version without losing anything, and be able to go back.
---

## Upgrade

Re-run the installer. It keeps your `.env`, refreshes the stack definition, pulls the new images and
restarts in place — no need to stop anything first.

```bash
curl -fsSL https://get.sarati.io | sh
```

Already have the current stack file and only want new images — not when a note below says the stack
file changed:

```bash
cd sarati && docker compose pull && docker compose up -d
```

Pin a version instead of tracking `latest` by setting `SARATI_VERSION` in `.env`.

Sarati runs as one instance. An upgrade stops it and starts the new version on the same data, and runs
in flight carry on where they were: a run waiting for an approval or on a **Wait** step keeps waiting.
The exception is a run an earlier version started that can't be resumed safely — one that had
already run steps side by side (parallel branches, or steps that start at the same time), whose AI
Agent step was refused a sub-workflow call and carried on, or whose history doesn't fit its workflow:
it [ends in `error`](/run/runs/#durability) as the new version starts, saying why, and none of its
steps runs again. A restart treats it the same
way. Let those runs finish first, or run them again after. Runs this version starts resume where they
were, through later restarts and upgrades.

The boot log counts the runs an earlier version started that are in flight, for example
`Runs an earlier version started, in flight at boot: 3 can resume, 1 can't be resumed safely and will fail, 0 had already ended`,
and names each one that fails at warn level with its reason, followed by a `RunNotResumable` error
and its stack trace: that is the run ending, not the service failing. Runs this version started are
not counted there, as only a run an earlier version started is judged this way. From v0.2.24 on, you
can list them before you restart or upgrade:

```bash
cd sarati && docker compose exec sarati sarati-legacy-report
```

It only reads, and prints each run an earlier version started that is in flight as `would resume`
or `would fail` with the reason, or `already ended` for one that had finished or been cancelled but
not yet stopped, which stays as it ended. A run can still move on between the report and the
restart, so each is judged again as it resumes. On a five-container install it is
`docker compose exec service` instead; running it by hand, `docker exec sarati`.

### Going back

Set `SARATI_VERSION` to the earlier version and upgrade again. What carries on there depends on the
version you go back to.

**To v0.2.26 or v0.2.25**, runs carry on as they do here: both resume a run this version started, on
the same engine. Its approvals stay listed and answerable there, a **Wait** step wakes there, a step
it was running when you went back runs again there, and coming back to this version picks it up
where it was.

**To v0.2.24**, a run v0.2.25 or later started doesn't carry on: v0.2.24 logs at boot that it can't
recover it. It stays in flight there: its approvals stay listed, and a decision made there is taken
when you come back to this version, which picks the run up where it was. Three things end it there in
an error, and coming back leaves it that way, running nothing more: an approval whose window passes, a
**Wait** step still parked `RUN_MAX_DURATION_SECONDS` after its time is up, and a step it was running
when you went back, once the run has been in flight for `RUN_MAX_DURATION_SECONDS`. Come back before
any of them to keep such runs: a **Wait** step whose time came while you were away then wakes.

**To v0.2.23 or earlier**, a run v0.2.25 or later started doesn't carry on either: let those runs
finish before going back that far. A run v0.2.24 or earlier started carries on there, and keeps its
waits only if none of them runs beside another step: approvals that come one after another, even on
the same topic, and a wait inside a loop. Let any such run with parallel branches, or with steps that
start side by side, finish before going back, even when only one of its approvals shows in the inbox.
There it can lose that approval, put a decision on the wrong wait, or end in an error. So can a run
with two approvals on one topic, neither waiting for the other, when the **If** and **Switch** steps
before either of them have more than 4096 combinations of routes, even if the two never wait at the
same time.

For a run that keeps its waits there:

- Its approval stays listed and answerable, and a **Wait** step still wakes.
- A decision made here that the run had not taken yet is applied there, but is not recorded with who
  made it. If it had not even gone out, because the service stopped as it was made, its wait is
  listed there to decide again.
- It shows one decider per run: whoever answered its last approval. A run with several approvals
  shows only that one there, and coming back to this version shows each on its own step again.
- The time it spent parked counts against `RUN_MAX_DURATION_SECONDS` there, so a run that resumed
  from a long wait may end in an error.
- Coming back to this version picks it up where it was left.

A step with no account chosen fails there: those versions need an app step to name an account, even
under an environment, where the environment's account is still the one it runs as. A run on Default
and **Test this branch** fail the same way. Pick an account on the step, and promote that version
again for an environment to run it. An AI Agent step is the exception under an environment: there it
runs as the environment's account with or without one.

**Triggers, going back to v0.2.25 or v0.2.24.** Neither holds a trigger whose environment's account
isn't active: there such a trigger is polled as that account, and a change a promote left waiting for
it is tried at its app as that account. A webhook delete waiting for its account to be active again
is tried there with that account, and one the app refuses that account for is given up: the log names
the webhook at warn level, so you can delete it in the app. Coming back holds such a trigger again at
once. One whose account became active while you were away listens again at the next fifteen-minute
sweep, when pg-boss is enabled (the default), or when its account next changes. Everything else
[v0.2.26 changed](#v0226-the-service-opens-no-port-but-its-own) goes back to how it was too, port 3001
included.

Running it by hand, without the installer:

```bash
docker pull sarati/sarati && docker rm -f sarati
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

## Notes for specific versions

### v0.2.26: the service opens no port but its own

The service listens on its `PORT` alone. Earlier versions, with durable runs on (`DBOS_ENABLED`, the
images' default), also opened port 3001 on every interface for the admin API of DBOS, the library
that makes runs durable. That API answers without signing in: it lists runs with what each started
with and every step's output, and cancels, resumes or forks any run. Neither stack file nor the
one-container image publishes the port, but any container on the same Docker network could reach it,
and so could anything that reaches the machine when the service runs outside Docker. Nothing in
Sarati used it, so it needs nothing from you.

What a caller of the API sees change:

- **Testing a branch under an environment takes the right to promote there.** In an organization
  only owners and admins have it, and an API key needs `workflow:deploy` as well as `run:execute`,
  in a personal workspace too. Without it the test answers `403` with the code
  `promote_not_permitted` and nothing runs; testing on Default is unchanged. A promote, publish,
  restore or un-promote refused for a member's role now carries the same code. See
  [Who can promote](/run/environments/#who-can-promote).
- **Promoting, publishing or restoring checks each app trigger against the environment's account
  for its app,** as it checks each step. Before, it refused only a trigger that named an account of
  its own where the environment had none assigned. A version whose trigger the account can't serve —
  there is none, it is for another app, it isn't active, or it is of the wrong kind — is refused with
  `428`, the trigger listed under `triggers`. A trigger already live on such an account stops
  listening at the first fifteen-minute sweep after the upgrade, when pg-boss is enabled (the
  default), and the workflow overview shows it as **Not listening** with the reason; one whose
  account only stopped being active is **held** instead,
  keeping what it set up at the app. A change to an account reconciles the triggers that listen as it
  straight away. The refusal for an account that isn't active now says its owner tests it under
  Integrations, where it used to say to reconnect it: **Reconnect** connects a new account, which
  the slot holds only once an owner assigns it. See
  [Triggers listen as the environment's account](/run/environments/#triggers-listen-as-the-environments-account).
- **Renaming an environment is refused with `409`** while one of its webhook triggers is registered
  with an account that isn't active, each listed under `held_webhooks`. No webhook delete is sent
  with such an account either: it waits until the account is active again. See
  [Rename and delete](/run/environments/#rename-and-delete).
- **Every request carrying the Composio API key follows a redirect only while it stays on the same
  origin.** One to another origin fails the call without retrying and names where it pointed, and
  neither the key nor the request reaches it. A managed step used to follow it there, key and all,
  and the service's own calls to Composio, such as a connect link, followed no redirect at all. See
  [the message](/operate/troubleshooting/#a-managed-step-says-composio-redirected-it-elsewhere).
  A username or password in `COMPOSIO_BASE_URL` or `CLERK_API_URL` now stops the service at boot;
  see [What survives](#what-survives).
- **Deleting an environment just after promoting into it** removes the new trigger with the others.
  It could answer `409` and leave that trigger set up at its app until a later reconcile.
- **A delete that crosses another write ends as if the two ran one after the other.** Deleting a
  workflow, an environment or an organization while another delete, or a write under the same
  organization, was under way could fail on a deadlock or with a `500`. Now they take turns: a write
  already under way lands first and the delete sees it, and a write that reaches what the delete
  holds waits for it, then answers `404` if what it changes is gone. A revoke and an accept of one
  invite, or two accepts, take turns the same way, so an invite admits one account.

### v0.2.25: runs with parallel branches resume as they ran

Runs this version starts resume after a crash, a restart or an upgrade where they were, parallel
branches included. A run an earlier version started goes on as [v0.2.24](#v0224-moving-to-this-version)
describes.

What a caller of the API sees change:

- **A raw plan's node ids keep to the rule a saved workflow's do:** letters, digits, `_` and `-`, at
  most 60 characters, starting with a letter or digit. `POST /api/runs` and `POST /api/runs/async`
  refuse a plan with any other id with `400` and the code `compile_failed` before any step runs.
- **A document handed to `POST /api/runs/from-ir`, to `POST /api/runs/async` as `workflow_ir`, or to
  MCP's `orchestr_test_workflow` is checked as a save checks it.** One with a step type no catalog
  knows, or an id outside that rule, is refused before any step runs.
- **A step in an error lane is keyed under the step that failed into it**, as `<that step's id>#error/<its
  id>`: in a run's `steps[].step_key`, in its waits in the inbox, and in a decision aimed at a
  `step_key`. A run an earlier version started keeps the keys it had.
- **A delay of 10 to 60 seconds ends within about ten seconds of a cancel**, where it used to run out.

### v0.2.24: moving to this version

**Five containers: re-run the installer.** The stack file changed — part of the rate-limit fix below
is in `docker-compose.yaml` and `docker/Caddyfile`, which only the installer refreshes — so
`docker compose pull` alone is not enough this time. One container needs only the new image.

**A run that can't be resumed safely now ends in an error when it resumes** — one that had already
run steps side by side, whose AI Agent step was refused a sub-workflow call and carried on, or whose
history doesn't fit its workflow. It
used to resume, and could then put a step's result or a decision in the wrong place, or end in an
error later. The runs in flight as you upgrade are judged the same way when this version first
starts, and its boot log says how many will fail. Earlier versions can't list them for you, so let
runs with parallel branches, and AI Agent steps that call workflows, finish before upgrading.

A few saved steps that ran before now stop with an error before sending anything, because they
could act on the wrong Jira site or send a credential somewhere it does not belong. Check the
workflows that use them before you upgrade; each fix is one field on the step.

- **A managed Jira step with a blank Instance URL, on a connection that reaches two or more sites,**
  used to run on the first of them. It now refuses and lists the sites: set Instance URL to the one
  to use.
- **A managed Jira step whose Instance URL names a site the connection can't reach,** such as
  `https://old.atlassian.net`, used to run on the connection's first site instead. It now refuses and
  lists the sites the connection can reach: set Instance URL to one of them.
- **A managed Jira step whose Instance URL is not a Jira Cloud host,** such as a self-hosted
  `https://jira.acme.com`, used to have it ignored. It now refuses: set Instance URL to your Jira
  Cloud site, `https://<your-site>.atlassian.net`.
- **A Salesforce step or trigger whose Instance URL is a legacy instance host** —
  `na123.salesforce.com`, a `cloudforce.com` host or an Experience Cloud `my.site.com` host — now
  refuses to send its credential there. Set Instance URL to your org's My Domain URL,
  `https://<your-domain>.my.salesforce.com`.

The messages and what to set are in Troubleshooting:
[a Jira step](/operate/troubleshooting/#a-jira-step-refuses-its-instance-url) and
[a Salesforce step](/operate/troubleshooting/#a-step-wont-send-its-connections-credential).

Rate limits now count per visitor — an IPv6 visitor per `/64` — and the AI composer's calls count
against the visitor who made them. Before, the service saw Sarati's own proxy as every visitor, so
they all shared one limit: one person's failed sign-ins locked everyone out, and anyone could switch
the composer off for everybody.

- **Behind another proxy** — Cloudflare, a load balancer, a Cloudflare Tunnel — list it in
  `SARATI_TRUSTED_PROXIES`; [Behind another proxy](/operate/configuration/#behind-another-proxy) says
  how.
- **`TRUST_PROXY_HEADERS` is replaced:** remove it from `.env`. With Sarati's own proxy it is ignored —
  a leftover `true` is reported in the boot log, a leftover `false` silently. `TRUST_PROXY_HOPS` is only
  for the images run without that proxy.
- **One container answers on 8080 only:** its service (8001) and composer (8010) now listen inside the
  container alone, so reach everything — the MCP endpoint included — through port 8080.

`COMPOSIO_FALLBACK_APPS` is removed. In v0.2.23 and earlier it only changed where a listed app's
step went when its type was neither a built-in action nor in the Composio catalog, and saving a
workflow refuses such a type, so nothing changes for a step a workflow can save. If the variable is
still set, the service logs one warning at boot and otherwise ignores it; delete the line from
`.env`.

### v0.2.23: outbound requests to private addresses

Every step and trigger that calls an address from this server now refuses a private or internal one,
in any spelling, on every redirect. Before, the HTTP and GraphQL steps, the HTTP and RSS triggers and
the OAuth token exchange checked the address once before sending — not the address actually connected
to, any redirect, or an IPv6 spelling of an IPv4 address, which let a private address through. Upgrade
from any earlier version.

What can newly refuse, and the fix for each, is in
[Private addresses](/operate/configuration/#private-addresses):

- app steps on your own credentials aimed at a host on your network
- redirects into private space
- an OAuth client entered in the Connect dialog whose host this server cannot resolve
- a server whose DNS hands out synthetic private addresses

Steps behind an egress proxy go through it when Node's `NODE_USE_ENV_PROXY=1` is set; keep the
stack's own addresses in `NO_PROXY`, as
[Private addresses](/operate/configuration/#private-addresses) lists.

## What survives

Everything in the volumes: workflows, versions, branches, reviews, runs, users, and stored
credentials. Removing a container removes nothing you care about. An upgrade keeps the same workflow
count and leaves connected accounts `active`, because the `FERNET_KEY` it already had still decrypts
them.

**Upgrading from v0.2.22 or earlier** starts every live trigger over once, as the upgraded service
starts: webhooks registered with an app are deleted and registered again, subscriptions are renewed,
polled triggers start from that moment, and schedules restart their interval. An item that arrives
between a polled trigger's last check and that moment may not start a run. Earlier releases did not
record what each trigger had registered, so this is the one time it is rebuilt from scratch. If an
earlier release changed an app-webhook trigger into a different kind of trigger, or emptied the
environment slot one ran on, the webhook it left registered can't be deleted for you: the service
log names it at warn level after that first rebuild, at the latest on the fifteen-minute sweep that
follows it, so you can delete it in the app. A webhook that an earlier release replaced after the
slot moved to another account, or after a GitHub trigger's repository changed, was never recorded,
so it is neither deleted nor named in the log: look in the old account or repository for webhooks
that point at this install, and delete them there.

**Upgrading from v0.2.22 or earlier** with `COMPOSIO_BASE_URL` set to a plain `http://` address on
another host stops the service at boot: every request to it carries the Composio API key, so it has
to be `https://`, or `http://` to the same machine. A value that isn't an http(s) URL, or that
carries a `?` or `#`, now stops it at boot too — neither ever sent a request to the right path.

**Upgrading from v0.2.25 or earlier** with a username or password in `COMPOSIO_BASE_URL` or
`CLERK_API_URL` stops the service at boot, and the message names only the address and path. Take
them out of the URL: neither was ever sent. Requests to the Clerk API and to the Composio API
dropped them, and with them in `COMPOSIO_BASE_URL` every managed step failed with an error that
repeated them.

## Back up

Your install is one container or five — `docker compose ps` in the `sarati` directory tells you
which. It matters here and almost nowhere else.

### One container

Everything lives in one volume, so the complete backup is that volume. Stop it first: a database
copied while it is running is not a consistent copy.

```bash
cd sarati && docker compose stop
```

```bash
docker run --rm -v sarati_data:/data -v "$PWD":/backup alpine tar czf /backup/sarati-data.tgz -C /data .
```

```bash
docker compose start
```

Restore by unpacking into a fresh volume and pointing an install at it:

```bash
docker run --rm -v sarati-restored:/data -v "$PWD":/backup alpine tar xzf /backup/sarati-data.tgz -C /data
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati-restored:/data sarati/sarati
```

**Without downtime**, dump the database and copy the keys out instead. This covers workflows,
versions, users and credentials, but not the checkpoints of runs that are in flight — those live in
a second database the dump does not reach.

```bash
cd sarati && docker compose exec sarati pg_dump --clean --if-exists --exclude-schema=pgboss -h 127.0.0.1 -U sarati sarati > sarati-backup.sql
```

```bash
docker compose cp sarati:/data/secrets.env sarati-secrets.env
```

**The dump is useless without that second file.** It holds `FERNET_KEY`, and no other key can
decrypt the credentials inside the dump.

Load one back, then restart so the engine reconnects:

```bash
docker compose exec -T sarati psql -h 127.0.0.1 -U sarati sarati < sarati-backup.sql && docker compose restart
```

### Five containers

Two things, and you need both.

**The database.**

```bash
cd sarati && docker compose exec -T db pg_dump -U sarati sarati > sarati-backup.sql
```

**The `.env` file**, which holds `FERNET_KEY`. A database backup without it is useless — the
credentials in it cannot be decrypted by any other key.

```bash
cp sarati/.env ~/somewhere-safe/sarati.env
```

Restore by stopping the stack, putting the `.env` back, bringing the database up on its own, and
loading the dump:

```bash
cd sarati && docker compose down
```

```bash
docker compose up -d db
```

```bash
cat sarati-backup.sql | docker compose exec -T db psql -U sarati sarati
```

```bash
docker compose up -d
```

## Start over

To wipe the instance and its data:

```bash
cd sarati && docker compose down -v
```

That deletes the volumes. Everything goes, including credentials.
