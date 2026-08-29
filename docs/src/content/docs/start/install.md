---
title: Install
description: Run Sarati locally or on a server with one command.
---

Docker is the only requirement. Two supported shapes of the same product — pick by whether you want
the pieces separate.

## One container

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

The first boot takes a minute or two while it creates its database. Then open
<http://localhost:8080> and create the owner account — the first account is yours, everyone after
joins by invite.

`-v sarati:/data` is not optional. That volume holds the database **and** the keys that decrypt your
stored credentials, so without it, removing the container destroys both.

### A different port

Map the port and tell it the URL it is reached on — webhook URLs and sign-in are minted from that:

```bash
docker run -d --name sarati -p 9090:8080 -e SARATI_URL=http://localhost:9090 -v sarati:/data sarati/sarati
```

### Your own Postgres

`DATABASE_URL` replaces the bundled database, which then never starts. `/data` still has to persist
— it holds `secrets.env`, and `FERNET_KEY` is what decrypts your credentials.

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data \
  -e DATABASE_URL=postgresql://user:password@host:5432/sarati sarati/sarati
```

### Everyday commands

```bash
docker logs -f sarati
```

```bash
docker rm -f sarati
```

Removing the container leaves the volume alone — that is how you [upgrade](/operate/upgrades/).

## Five containers

Want the services apart — their own database container, per-service logs and restarts, and settings
in a file instead of `-e` flags? The installer sets that up:

```bash
curl -fsSL https://get.sarati.io | sh
```

It downloads `docker-compose.yaml`, generates this install's secrets into `.env`, and starts five
containers. When it prints the URL, open <http://localhost:8080> and create the owner account.

Prefer to read it first? It only fetches
[`docker-compose.yaml`](https://github.com/saratihq/sarati/blob/main/docker-compose.yaml) and
[`install.sh`](https://github.com/saratihq/sarati/blob/main/install.sh).

### Choose a different port

```bash
SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

The installer stops before doing anything if the port is already in use.

### Back up `.env`

The installer writes `sarati/.env` and never overwrites it, so re-running the command is a safe
[upgrade](/operate/upgrades/) — stop the stack first, or the port check turns it away.

Back that file up. **Losing `FERNET_KEY` makes stored credentials unrecoverable** — no reset, no
recovery. Rotating `SECRET_KEY` signs everyone out.

### Everyday commands

Run these from the `sarati` directory the installer created.

```bash
docker compose logs -f
```

```bash
docker compose down
```

```bash
docker compose pull && docker compose up -d
```

### Run a second instance

One machine can hold several installs, each with its own database:

```bash
COMPOSE_PROJECT_NAME=sarati-2 SARATI_DIR=sarati-2 SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

The one-container equivalent is a second name, port and volume:

```bash
docker run -d --name sarati-2 -p 9090:8080 -e SARATI_URL=http://localhost:9090 -v sarati-2:/data sarati/sarati
```

If a Sarati database already exists but its `.env` is gone, the installer refuses to start rather
than write new secrets a `FERNET_KEY` can no longer decrypt. Restore the `.env`, or remove the
volume and start over:

```bash
docker volume rm sarati_db-data
```

## What is running

The same five processes either way — as five containers under compose, or as five processes under
one supervisor in the single container.

| | What it is |
|---|---|
| `proxy` | Caddy. The only published port — everything is reached through one origin. |
| `client` | The UI. |
| `service` | The API and the execution engine. |
| `agent` | The AI composer. Idle until you give it a key. |
| `db` | Postgres 16. |

The AI composer is off until an owner or admin adds an Anthropic key in **Settings → Platform
keys** — inside the running app, not in `.env`. Everything else works without it.

## Run it from source

Building on Sarati itself rather than running it? The service, client and agent run directly from a
clone — see
[CONTRIBUTING.md](https://github.com/saratihq/sarati/blob/main/CONTRIBUTING.md#getting-set-up).
