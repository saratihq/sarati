---
title: Environments
description: Point each environment at its own version, with its own accounts and its own URLs.
---

An environment is a **pointer at one version**. Each workspace has its own environments, starting
with `production`, `staging` and `uat`; promoting to a name the workspace doesn't have yet creates
it.

`production` and `uat` cannot be renamed or deleted.

The workflow overview shows which version each environment is on, and whether the branch head has
moved past it:

<img class="shot shot-dark" src="/shots/env-rail-dark.webp" alt="A workflow overview with the runtime rail showing the live version and trigger state." />
<img class="shot shot-light" src="/shots/env-rail-light.webp" alt="A workflow overview with the runtime rail showing the live version and trigger state." />

## Promote

Promoting moves the pointer. Nothing is copied, and the version being promoted does not change.

```
POST /api/workflows/<id>/promote
{"environment":"staging","version_id":"40cb9926-…"}

{"status":"promoted","environment":"staging","version_number":1,"previous_version_number":null}
```

Two environments can sit on different versions of the same workflow at the same time, and each has
its own webhook URL:

```bash
curl -X POST http://localhost:8080/api/hooks/<id>/production   # runs v7 → 10 stories
```

```bash
curl -X POST http://localhost:8080/api/hooks/<id>/staging      # runs v1 → 7 stories
```

Same workflow. Same moment. Different versions, because the pointers differ.

## Where a branch can go

`staging` and any environment you add accept a version from **any branch** — that is the point of a
staging environment.

`production` and `uat` take the default branch only:

> 'production' promotes from the default branch only — merge the branch first.

So the path to production runs through `main`, and through whatever review gate `main` carries.

## Connections belong to the environment

A step names the app it needs; the environment supplies the account. Staging hits the sandbox
account, production hits the real one, and the workflow document never contains a credential.

Sharing a workflow therefore never shares a credential.

## Rename and delete

An environment's name is part of its URLs, so renaming `staging` to `qa` moves
`/api/hooks/<id>/staging` to `/api/hooks/<id>/qa`. A trigger registered with an app — a GitHub or
Stripe webhook — follows on its own: the webhook at the old URL is deleted and a new one is
registered at the new URL. A URL you gave a sender yourself, for an incoming webhook or a chat,
changes too, so update it there.

When a rename would move one of those, Sarati asks first: the confirmation lists each incoming
webhook and chat in the environment with its new URL. Through the API, the rename answers `409`
with the same list in `url_changes` until you send it again with `"confirm_url_changes": true`:

```
PATCH /api/environments/<id>
{"name":"qa","confirm_url_changes":true}
```

Deleting an environment unpromotes every workflow from it and removes its triggers from their apps
before the environment goes: webhooks are deleted and subscriptions cancelled. A webhook the app
can't delete just then is retried on later reconciles after the environment is gone, every fifteen
minutes when pg-boss is enabled; see
[Changing a live app trigger](/build/triggers/#changing-a-live-app-trigger).

## Publishing

**Publish** is promote-to-production. See
[Save, version, publish](/version-control/save-version-publish/).
