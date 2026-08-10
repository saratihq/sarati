---
title: Upgrades and backups
description: Move to a new version without losing anything, and be able to go back.
---

## Upgrade

Stop the stack first, then re-run the installer in the same directory:

```bash
cd sarati && docker compose down
```

```bash
curl -fsSL https://get.sarati.io | sh
```

`docker compose down` removes the containers and leaves the volumes, so nothing is lost. The
installer keeps the existing `.env` untouched and refreshes `docker-compose.yaml`, which is how new
settings become reachable.

It will **refuse to run while the stack is up**:

```
error: Port 8080 is already in use. Re-run with SARATI_PORT=9090 (or any free port).
```

That is the port check, not a failed upgrade — stop the stack and run it again.

Already have the current compose file and only want new images:

```bash
docker compose pull && docker compose up -d
```

Pin a version instead of tracking `latest` with `SARATI_VERSION` in `.env`.

## What survives

Everything in the volumes: workflows, versions, branches, reviews, runs, users, and stored
credentials. An upgrade over an existing install keeps the same workflow count and leaves connected
accounts `active`, because `FERNET_KEY` in the untouched `.env` still decrypts them.

## Back up

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

:::caution
If the installer generated your keys onto the service's data volume instead of `.env`
(`/data/secrets.env`), back that volume up too. Losing `FERNET_KEY` makes every stored credential
unrecoverable — there is no reset.
:::

## Restore

```bash
cd sarati && docker compose down
```

Put the `.env` back, bring the database up on its own, and load the dump:

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
