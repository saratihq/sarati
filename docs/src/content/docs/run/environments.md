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
account, production hits the real one, and the workflow document never contains a credential. A
step runs as its environment's account whether or not it names one of its own. Sharing a workflow
therefore never shares a credential.

An environment's slot for an app takes only an account for that app — assigning another app's is
refused. Promoting or publishing to an environment that has no account for a step's app, whose
account can't run the step, or whose account for it isn't active, is refused up front, naming the
step:

> staging has no gmail account assigned, so "Email me the report" can't run there — assign one
> under Integrations → Environments before promoting here

A step whose action runs only through one-click sign-in can't run on a slot account connected with
its own key:

> staging's slack account uses its own credentials, and "Remind me" runs only on a one-click
> (managed) one, so it can't run there — reassign it under Integrations → Environments before
> promoting here

An account that isn't active is refused the same way, and its owner reconnecting it mends it as well
as an owner reassigning the slot:

> staging's gmail account isn't active, so "Email me the report" can't run there — its owner
> reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments
> before promoting here

A run already there stops before that step calls the app, naming the step and the environment as it
is called now.

### Triggers listen as the environment's account

An app trigger — a GitHub or Stripe webhook, a polled Slack or Gmail feed, a one-click (Composio)
subscription — listens as its environment's account for its app, whether or not it names an account
of its own. Promoting, publishing or restoring a version whose trigger that account can't serve is
refused the same way, naming the trigger:

> staging has no gmail account assigned, so "New email" can't run there — assign one under
> Integrations → Environments before promoting here

An account for another app, or one that isn't active, is refused in the words a step's is. The
refusal lists the triggers apart from the steps, under `triggers`, with the same reasons:

```
{"code":"environment_slots_inactive","environment":"staging","apps":["gmail"],"steps":[],
 "triggers":[{"node_id":"watch","node_name":"New email","app":"gmail","reason":"inactive_slot"}]}
```

A trigger already live in an environment whose account stops serving it is taken down, and the
workflow overview shows why in the same words. Emptying or reassigning the slot does this at once; an
account that stops being active is noticed within fifteen minutes, when pg-boss is enabled. The
trigger starts again, fresh, once the environment has an account that serves it. A trigger that signs
in to nothing — a schedule, an incoming webhook or chat, an RSS or HTTP feed — needs no account.

## Rename and delete

An environment's name is part of its URLs, so renaming `staging` to `qa` moves
`/api/hooks/<id>/staging` to `/api/hooks/<id>/qa`. A trigger registered with an app — a GitHub or
Stripe webhook — follows on its own: the webhook at the old URL is deleted and a new one is
registered at the new URL. A URL you gave a sender yourself, for an incoming webhook or a chat,
changes too, so update it there.

When a rename would move one of those, Sarati asks first: the confirmation lists each incoming
webhook and chat promoted to the environment, with its old and new URL. Through the API, the rename
answers `409` with that list in `url_changes`; send the list back as `confirm_url_changes` to go
ahead. Each entry counts for exactly the old and new URL it names, so if a webhook or chat was
promoted there since, or the environment was renamed meanwhile, the rename answers `409` again with
the current list, and nothing moves without being listed first:

```
PATCH /api/environments/<id>
{"name":"qa","confirm_url_changes":[{"workflow_id":"7fb69691-…","trigger":"webhook",
  "from":"/api/hooks/7fb69691-…/staging","to":"/api/hooks/7fb69691-…/qa"}]}
```

Deleting an environment unpromotes every workflow from it and removes its triggers from their apps
before the environment goes: webhooks are deleted and subscriptions cancelled. A webhook the app
can't delete just then, or doesn't answer for within ten seconds, is retried on later reconciles after
the environment is gone, every fifteen minutes when pg-boss is enabled; see
[Changing a live app trigger](/build/triggers/#changing-a-live-app-trigger). Deleting a workflow
removes its triggers from their apps the same way.

If a workflow is promoted or published while one of these deletes is running, the delete keeps the
environment or workflow and answers `409`; send it again. A change that reaches a workflow as its
delete is finishing waits for the delete, then answers `404`.

## Publishing

**Publish** is promote-to-production. See
[Save, version, publish](/version-control/save-version-publish/).
