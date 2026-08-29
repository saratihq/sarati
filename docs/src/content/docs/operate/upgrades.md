---
title: Upgrades and backups
description: Move to a new version without losing anything, and be able to go back.
---

## Upgrade

### One container

```bash
docker pull sarati/sarati
```

```bash
docker rm -f sarati && docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

Removing the container removes nothing you care about — the database and the keys are in the
`sarati` volume, and the new one picks them up. Pin a version by naming it, `sarati/sarati:0.2.4`,
instead of tracking `latest`.

### Five containers

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
accounts `active`, because the `FERNET_KEY` it already had still decrypts them.

## Back up — one container

Everything lives in one volume, so the complete backup is that volume. Stop the container first: a
database copied while it is running is not a consistent copy.

```bash
docker stop sarati
```

```bash
docker run --rm -v sarati:/data -v "$PWD":/backup alpine tar czf /backup/sarati-data.tgz -C /data .
```

```bash
docker start sarati
```

Restore by unpacking into a fresh volume and starting a container on it:

```bash
docker run --rm -v sarati-restored:/data -v "$PWD":/backup alpine tar xzf /backup/sarati-data.tgz -C /data
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati-restored:/data sarati/sarati
```

### Without stopping it

A dump plus the keys, with no downtime. This covers workflows, versions, users and credentials, but
not the checkpoints of runs that are in flight — those live in a second database the dump does not
reach.

```bash
docker exec sarati pg_dump --clean --if-exists --exclude-schema=pgboss -h 127.0.0.1 -U sarati sarati > sarati-backup.sql
```

```bash
docker cp sarati:/data/secrets.env sarati-secrets.env
```

**The dump is useless without that second file.** It holds `FERNET_KEY`, and no other key can
decrypt the credentials inside the dump.

Load one back, then restart so the engine reconnects:

```bash
docker exec -i sarati psql -h 127.0.0.1 -U sarati sarati < sarati-backup.sql && docker restart sarati
```

## Back up — five containers

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

### Restore

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

To wipe a one-container instance and its data:

```bash
docker rm -f sarati && docker volume rm sarati
```

Or a compose one:

```bash
cd sarati && docker compose down -v
```

Either deletes the volumes. Everything goes, including credentials.
