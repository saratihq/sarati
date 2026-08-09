---
title: Install
description: Run Sarati locally or on a server with one command.
---

Docker is the only requirement.

```bash
curl -fsSL https://get.sarati.io | sh
```

The installer downloads `docker-compose.yaml`, generates this install's secrets into `.env`, and
starts five containers. When it prints the URL, open <http://localhost:8080> and create the owner
account — the first account is yours, everyone after joins by invite.

Prefer to read it first? It only fetches
[`docker-compose.yaml`](https://github.com/saratihq/sarati/blob/main/docker-compose.yaml) and
[`install.sh`](https://github.com/saratihq/sarati/blob/main/install.sh).

## Choose a different port

```bash
SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

The installer stops before doing anything if the port is already in use.

## Back up `.env`

The installer writes `sarati/.env` and never overwrites it, so re-running the command is a safe
upgrade.

Back that file up. **Losing `FERNET_KEY` makes stored credentials unrecoverable** — no reset, no
recovery. Rotating `SECRET_KEY` signs everyone out.

## Everyday commands

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

## Run a second instance

One machine can hold several installs, each with its own database:

```bash
COMPOSE_PROJECT_NAME=sarati-2 SARATI_DIR=sarati-2 SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

If a Sarati database already exists but its `.env` is gone, the installer refuses to start rather
than write new secrets a `FERNET_KEY` can no longer decrypt. Restore the `.env`, or remove the
volume and start over:

```bash
docker volume rm sarati_db-data
```

## What is running

| Container | What it is |
|---|---|
| `proxy` | Caddy. The only published port — everything is reached through one origin. |
| `client` | The UI. |
| `service` | The API and the execution engine. |
| `agent` | The AI composer. Idle until you give it a key. |
| `db` | Postgres 16. |

The AI composer is off unless you set `ANTHROPIC_API_KEY` in `.env`. Everything else works without
it.

## Run it from source

Building on Sarati itself rather than running it? The service, client and agent run directly from a
clone — see
[CONTRIBUTING.md](https://github.com/saratihq/sarati/blob/main/CONTRIBUTING.md#getting-set-up).
