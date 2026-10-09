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
log names it at warn level on that first rebuild, so you can delete it in the app.

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
