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

This is a guard, not a bug, and only a five-container install can reach it: fresh secrets against an
old database give Postgres a password it never had, and a new `FERNET_KEY` cannot decrypt what the
old one stored. A one-container install keeps its keys inside the data volume, so the two cannot be
separated in the first place.

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

## The composer is not there

Without an Anthropic key the composer is absent, not broken: **New workflow** opens a bare canvas and
the editor has no Composer panel. An empty dashboard says which of the two reasons it is.

**"AI composer needs an Anthropic API key — add one under Settings"** — an owner or admin adds one in
**Settings → Platform keys**. It takes effect immediately; reload any other tab that was already open.

**"AI composer isn't configured on this instance — see docs"** — the agent container is missing the
shared secret, so it can neither verify your session nor read the stored key. `docker compose` passes
it for you; a hand-rolled deployment has to. Check it landed:

```bash
docker compose exec agent printenv SECRET_KEY
```

## The composer answers with an error

When Anthropic refuses a message, the composer says which refusal it was.

**"Anthropic rejected the API key saved for the composer."** — the key is mistyped, revoked or
expired. Replace it in **Settings → Platform keys**; the new one takes effect straight away.

**"The Anthropic account behind the composer's API key is out of credit."** — add credit to that
account, or replace the key.

**"Anthropic is rate-limiting the composer's API key."**, **"Anthropic is overloaded right now."** and
**"Anthropic returned a server error."** — nothing to fix on your side. Wait a minute and send the
message again.

**"The composer's model (…) is not available to the saved Anthropic API key."** — set
[`COMPOSER_MODEL`](/operate/configuration/#commonly-set) to a model the key can use.

Anything else reads **"The composer hit a problem — please try again."**, and the reason is in
[the logs](#reading-the-logs).

## A step says it needs a connection

```json
{"detail":"Step \"slack.list_channels\" requires a slack connection — attach one to this step and retry"}
```

Connect the app, then name that connection on the step. See
[Connections](/build/connections/).

## An AI Agent step says it has no Claude connection

```json
{"detail":"This agent step has no Claude connection to call the model with. Connect one under Integrations → \"Use your own credentials\" → Claude, then pick it on the step's model. The Anthropic key in Settings → Platform keys powers the AI composer only, not agent steps."}
```

The two Anthropic credentials are separate on purpose: the Settings key builds workflows, a
connection runs them. See
[Connections](/build/connections/#the-ai-agent-step-needs-one-too).

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

```
Target branch is protected — the pre-merge test is failing (a step errors on this branch that passes on the target). Fix it and re-test before merging. The latest test of these versions is on review "…".
```

Also intended: the latest test of the two versions found a step that errors on your branch but not
on the target. Fix the step and commit, or re-test once it passes — see
[Reviews](/version-control/reviews/#merge).

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
docker logs -f sarati
```

Under compose, per service:

```bash
cd sarati && docker compose logs -f service
```

```bash
docker compose logs --since 10m service
```

Turn up detail with `LOG_LEVEL=debug` in `.env`.
