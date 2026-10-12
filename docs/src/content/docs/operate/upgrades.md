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

Running it by hand, without the installer:

```bash
docker pull sarati/sarati && docker rm -f sarati
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

## Notes for specific versions

### v0.2.24: moving to this version

A few saved steps that ran before now stop with an error before sending anything, because they
could act on the wrong Jira site or send a credential somewhere it does not belong. Check the
workflows that use them before you upgrade; each fix is one field on the step.

- **A managed Jira step with a blank Instance URL, on a connection that reaches two or more sites,**
  used to run on the first of them. It now refuses and lists the sites: set Instance URL to the one
  to use.
- **A managed Jira step whose Instance URL names a site the connection can't reach** used to run on
  the connection's first site instead. It now refuses and lists the sites the connection can reach:
  set Instance URL to one of them.
- **A managed Jira step whose Instance URL is not a Jira Cloud host,** such as a self-hosted address,
  used to have it ignored. It now refuses: set Instance URL to your Jira Cloud site,
  `https://<your-site>.atlassian.net`.
- **A Salesforce step or trigger whose Instance URL is a legacy instance host** —
  `na123.salesforce.com`, a `cloudforce.com` host or an Experience Cloud `my.site.com` host — now
  refuses to send its credential there. Set Instance URL to your org's My Domain URL,
  `https://<your-domain>.my.salesforce.com`.

The messages and what to set are in Troubleshooting:
[a Jira step](/operate/troubleshooting/#a-jira-step-refuses-its-instance-url) and
[a Salesforce step](/operate/troubleshooting/#a-step-wont-send-its-connections-credential).

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
