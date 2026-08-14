---
title: Troubleshooting
description: The failures you are most likely to hit, and what each one means.
---

Every message on this page is one the product actually prints.

## The installer stops on the port

```
error: Port 8080 is already in use. Re-run with SARATI_PORT=9090 (or any free port).
```

Either Sarati is already running — stop it before [upgrading](/operate/upgrades/) — or something
else owns the port. Pick another with `SARATI_PORT`.

## The installer refuses because the database outlived its `.env`

```
error: A Sarati database already exists on this machine, but its .env is gone — these new
secrets would not match it.
```

This is a guard, not a bug. Fresh secrets against an old database give Postgres a password it never
had, and a new `FERNET_KEY` cannot decrypt what the old one stored.

Restore the `.env` if you have it. To run a **second** instance alongside the first:

```bash
COMPOSE_PROJECT_NAME=sarati-2 SARATI_DIR=sarati-2 SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
```

To erase the old database and start over:

```bash
docker volume rm sarati_db-data
```

## A webhook returns 404

```json
{"detail":"Webhook not found"}
```

No version carrying that trigger is live in that environment. Promote one — a URL exists as soon as
you save, but it does nothing until something is live behind it. Check the id too.

## A webhook returns 401

```json
{"detail":"Invalid webhook signature"}
```

Signature verification is on and the delivery did not match. The signature covers the **exact bytes**
sent, so re-serializing the body between signing and sending breaks it. Confirm a secret is set:

```bash
curl "http://localhost:8080/api/workflows/<id>/webhook-secret?node_id=trigger&environment=production"
```

`{"secret_present":false}` means verification is on with nothing to verify against.

## A run ends in `error`

The run and the failing step both carry the reason, for example
`http.send_request failed: HTTP 500`. There is no retry button — see
[Runs](/run/runs/#when-a-step-fails) for the three things that do exist.

## A run is stuck `running`

If the worker came back, it resumes on its own. If it never comes back, the reaper moves the run to
`error` once it passes `RUN_MAX_DURATION_SECONDS`, within five minutes.

## The composer says it is unavailable

It tells you which of the two reasons it is.

**"No Anthropic API key has been set"** — an owner or admin adds one in **Settings → Platform keys**.
It takes effect immediately; reload the page if a tab was already open.

**"Set SECRET_KEY to the same value the workflow service uses"** — the agent container is missing the
shared secret, so it can neither verify your session nor read the stored key. `docker compose` passes
it for you; a hand-rolled deployment has to. Check it landed:

```bash
docker compose exec agent printenv SECRET_KEY
```

## A step says it needs a connection

```json
{"detail":"Step \"slack.list_channels\" requires a slack connection — attach one to this step and retry"}
```

Connect the app, then name that connection on the step. See
[Connections](/build/connections/).

## An API call returns 403 naming a scope

```json
{"detail":"This API key is missing the \"workflow:write\" scope."}
```

Mint a key with the scope. Scopes are fixed at creation — see [API keys](/agents/api-keys/).

## A merge is refused

```
Branch 'main' is protected — merge it through an approved review
```

Working as intended. Open a review and get it approved. Committing straight to a protected branch is
refused the same way.

## A setting is not taking effect

```bash
docker compose exec service printenv THE_SETTING
```

Nothing back means it is not reaching the service. It must be in the `.env` beside your
`docker-compose.yaml`, and you need `docker compose up -d` — restarting the container is not enough.
Older stack files did not pass `.env` through at all; refresh `docker-compose.yaml` by re-running the
installer.

## Reading the logs

```bash
cd sarati && docker compose logs -f service
```

```bash
docker compose logs --since 10m service
```

Turn up detail with `LOG_LEVEL=debug` in `.env`.
