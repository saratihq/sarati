---
title: Install
description: Run Sarati locally or on a server with one command.
---

Docker is the only requirement.

```bash
curl -fsSL https://get.sarati.io | sh
```

That checks Docker is running, refuses a port that is already taken, writes a `sarati` directory to
configure and upgrade from, starts the product, and waits until it answers. Open
<http://localhost:8080> and create the owner account — the first account is yours, everyone after
joins by invite.

Prefer to read it first? It only fetches
[`install.sh`](https://github.com/saratihq/sarati/blob/main/install.sh) and
[`docker-compose.single.yaml`](https://github.com/saratihq/sarati/blob/main/docker-compose.single.yaml).

## Without the installer

The same product, one container, no script to trust:

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

`-v sarati:/data` is not optional here. That volume holds the database **and** the keys that decrypt
your stored credentials, so without it, removing the container destroys both. The installer is worth
using mainly because it cannot get that wrong.

## Choose a different port

```bash
SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

Or, running it by hand, map the port and tell it the URL it is reached on — webhook URLs and sign-in
are minted from that:

```bash
docker run -d --name sarati -p 9090:8080 -e SARATI_URL=http://localhost:9090 -v sarati:/data sarati/sarati
```

## Your own Postgres

`DATABASE_URL` replaces the bundled database, which then never starts. `/data` still has to persist
— it holds `secrets.env`, and `FERNET_KEY` is what decrypts your credentials. Put it in the
installer's `.env`, or pass it with `-e`.

```bash
DATABASE_URL=postgresql://user:password@host:5432/sarati
```

## Everyday commands

From the `sarati` directory the installer created:

```bash
docker compose logs -f
```

```bash
docker compose down
```

Running it by hand instead, it is `docker logs -f sarati` and `docker rm -f sarati`. Removing the
container leaves the volume alone — that is how you [upgrade](/operate/upgrades/).

## Run a second instance

One machine can hold several installs, each with its own database:

```bash
COMPOSE_PROJECT_NAME=sarati-2 SARATI_DIR=sarati-2 SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

## The pieces apart

One container is the default because it is one thing to run, back up and move, and because it keeps
the keys in the same volume as the database they decrypt. Some installs want the services separate
— their own database container, per-service logs and restarts, independent images:

```bash
SARATI_STACK=compose sh -c 'curl -fsSL https://get.sarati.io | sh'
```

That fetches [`docker-compose.yaml`](https://github.com/saratihq/sarati/blob/main/docker-compose.yaml)
instead and starts five containers, generating `SECRET_KEY`, `FERNET_KEY` and `POSTGRES_PASSWORD`
into `.env`. **Back that file up** — losing `FERNET_KEY` makes stored credentials unrecoverable.

An install that already exists keeps the shape it was built with, so re-running the installer over a
five-container install stays on five. The two store their data differently; nothing switches
underneath you.

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

## What it talks to

A self-hosted Sarati sends no telemetry: no analytics, no crash reporting, no update checks. The
installer fetches its stack definition from GitHub and pulls the image from the registry, and after
that the instance only contacts what you connect — the accounts you link, Composio if you add a key,
Clerk if you configure cloud sign-in, and the model provider behind the composer. The pages your
browser loads come from your instance too, fonts included.

## Run it from source

Building on Sarati itself rather than running it? The service, client and agent run directly from a
clone — see
[CONTRIBUTING.md](https://github.com/saratihq/sarati/blob/main/CONTRIBUTING.md#getting-set-up).
