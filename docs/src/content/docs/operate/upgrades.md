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

Already have the current stack file and only want new images:

```bash
cd sarati && docker compose pull && docker compose up -d
```

Pin a version instead of tracking `latest` by setting `SARATI_VERSION` in `.env`.

Sarati runs as one instance. An upgrade stops it and starts the new version on the same data, and runs
in flight carry on where they were: a run waiting for an approval or on a **Wait** step keeps waiting.
The exception, until a fix for how runs resume lands, is a run with a wait in a parallel branch or
beside another step that runs at the same time: it can fail when it resumes, as
[Approvals](/run/approvals/#more-than-one-wait-at-once) describes. Let those finish before upgrading.

### Going back

Set `SARATI_VERSION` to the earlier version and upgrade again.

On the earlier version, a run keeps its waits only if none of them runs beside another step: approvals
that come one after another, even on the same topic, and a wait inside a loop. Let any run with
parallel branches, or with steps that start side by side, finish before going back, even when only
one of its approvals shows in the inbox. There it can lose that approval, put a decision on the wrong
wait, or end in an error. So can a run whose two approvals on one topic sit behind more than 4096
combinations of **If** and **Switch** outcomes.

For a run that keeps its waits:

- Its approval stays listed and answerable on the earlier version, and a **Wait** step still wakes.
- A decision made here that the run had not taken yet is applied there, but the earlier version does
  not record who made it. If it had not even gone out, because the service stopped as it was made,
  its wait is listed there to decide again.
- Coming back to this version picks it up where the earlier version left it.

Running it by hand, without the installer:

```bash
docker pull sarati/sarati && docker rm -f sarati
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

## Notes for specific versions

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
