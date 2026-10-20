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

An account that isn't active is refused the same way. It is active again once its owner's **Test**
under Integrations finds it working, or it renews itself. **Reconnect** connects a new account
instead, which the slot holds only once an owner assigns it:

> staging's gmail account isn't active, so "Email me the report" can't run there — its owner tests it
> under Integrations once it works again, or an owner reassigns the slot under Integrations →
> Environments before promoting here

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

A one-click (Composio) trigger — a subscription, or Gmail's polled new-mail trigger — runs only on a
one-click account, so a slot account connected with its own key is refused as it is for a step that
runs only on one:

> staging's gmail account uses its own credentials, and "New email" runs only on a one-click
> (managed) one, so it can't run there — reassign it under Integrations → Environments before
> promoting here

Any other app trigger — a GitHub or Stripe webhook, a polled Slack feed — signs in with the account's
own credentials, which a one-click account never hands over, so a one-click slot account is refused
for it, with the reason `needs_own_credentials_slot`:

> staging's stripe account is one-click (managed), and "New customer" runs only on one that uses its
> own credentials, so it can't run there — reassign it under Integrations → Environments before
> promoting here

A live trigger whose own account stops being active is **held**, not taken down. What it set up at
the app stays — a GitHub or Stripe webhook, a Composio subscription — and so does how far its feed
had read:

- A polled feed isn't polled while it is held, so the workflow overview shows it as **Not
  listening**. Once the account is active again it picks up from where it stopped, including what
  arrived while it was held.
- A webhook or a subscription still receives what its app sends, and each delivery still starts a
  run, so the overview shows it as **Held**. A GitHub, Stripe or other webhook the service verifies
  itself checks each delivery with the webhook's signing secret alone, never with the account, so a
  delivery fires however the account stopped working, and none renews its token. A trigger that reads
  more from the app to describe the event, as ClickUp's reads the task, reads with no credential while
  it is held, and the run starts with what the delivery carried. A step of that run that calls the
  app as the account is refused, as any step is while the account isn't active.
- Nothing is changed at the app with the account while it isn't active. A new version's trigger
  settings wait until the account is active again, keeping what is live. Meanwhile what the app
  sends is for the old trigger, so it starts no run, and a polled feed isn't polled, so the overview
  shows the trigger as **Not listening** and its reason says the change waits. Once the account is
  active again the change is made and the trigger starts afresh, without what happened at the app
  meanwhile. A webhook's move for a rename made just before the account stopped being active waits
  too: the app keeps sending to the old environment name's URL, which no longer serves the trigger,
  so it reads as **Not listening** in the same words. Any later rename is refused instead, because
  the webhook would stay at a URL that no longer serves it; see [Rename and delete](#rename-and-delete).
- A webhook's move to a new public URL for the service waits as well, but its path stays the same,
  and the service takes a delivery by its path whatever address it came in on. So while the old
  address still reaches the service — another name for the same host, or `http` where it is now
  `https` — what the app sends there still starts a run, and the overview shows it as **Held**, its
  reason saying the move waits. An old address that no longer reaches the service, such as a
  replaced tunnel's, delivers nothing. Once the account is active again the webhook moves to the new
  URL.
- A webhook taken down meanwhile — its trigger removed or replaced, its slot given another account,
  its workflow or environment deleted — is deleted at the app once that account is active again; if
  the account is removed first, the log names the webhook to delete in the app. An app that keeps one
  webhook per address, such as GitHub, refuses the trigger registered anew as the slot's new account
  while the old webhook is there, so the old one is deleted with the new account first, once the app
  answers that it deleted it. If the new account can't reach it — GitHub answers an account that
  can't administer the repository as if the webhook weren't there — the delete waits for the
  account that registered it, and the trigger's reason gives the app's refusal.

The overview gives the reason, and what makes the account active again. A trigger whose stand-up
never finished had nothing live to hold, so it waits as a new one does, saying it can't run there.
Until a stand-up finishes, the overview shows a trigger as **Not listening**, with the app's error.

A live trigger is taken down when its slot is emptied, given another account, given another app's,
or given one of the wrong kind: one that uses its own credentials for a one-click trigger, or a
one-click one for any other. It starts fresh once the slot serves it. These changes, and any change
to an account — it stops or starts being active, or is removed — reconcile the triggers that listen
as it straight away, not at the fifteen-minute sweep. An account that keeps flipping queues at most
one more reconcile for each workflow while one runs, not one per change. If the slot changes again
before it serves the trigger, or the environment is renamed, the reason changes with it. Creating a
workflow is not refused this way: when its first version goes live, a trigger the account can't
serve waits in the same way, with the reason on the overview. A trigger that signs in to nothing — a
schedule, an incoming webhook or chat, an RSS or HTTP feed — needs no account.

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

A webhook registered with an app can only be moved with the account it was registered with, so while
that account isn't active the rename is refused with `409`, before anything is asked to be
confirmed: the old webhook would stay registered at a URL that no longer serves it, and what the app
sends would be lost until the account is active again. The refusal names each such trigger, its
workflow and the account, and lists them under `held_webhooks`:

> Renaming 'staging' would leave "New customer" in "Billing" registered at its old URL, which serves
> nothing, because the stripe account it was registered with (Billing Stripe) isn't active — before
> renaming, its owner tests it under Integrations once it works again, or an owner reassigns the slot
> under Integrations → Environments

A webhook already taken down, waiting for its account to come back so it can be deleted, does not
hold up a rename.

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
