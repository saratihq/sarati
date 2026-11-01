---
title: Upgrades and backups
description: Move to a new version without losing anything, and be able to go back.
---

## Upgrade

Re-run the installer. It keeps your `.env`, refreshes the stack definition, pulls the new images and
restarts what changed in place — the proxy too, unless the installer last started it on the same
`docker/Caddyfile` it just fetched and found that file on disk unchanged. No need to stop anything
first.

```bash
curl -fsSL https://get.sarati.io | sh
```

Already have the current stack file and only want new images — not when a note below says the stack
file changed:

```bash
cd sarati && docker compose pull && docker compose up -d
```

Running it by hand, without the installer:

```bash
docker pull sarati/sarati && docker rm -f sarati
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data sarati/sarati
```

Pin a version instead of tracking `latest` by setting `SARATI_VERSION` in `.env`. Pin 0.2.26 or
later: every earlier version has a published
[security advisory](https://github.com/saratihq/sarati/security/advisories), and the installer warns
when it starts one.

Sarati runs as one instance. An upgrade stops it and starts the new version on the same data, and runs
in flight carry on where they were: a run waiting for an approval or on a **Wait** step keeps waiting.
The exception is a run v0.2.24 or earlier started that can't be resumed safely — one that had
already run steps side by side (parallel branches, or steps that start at the same time), whose AI
Agent step was refused a sub-workflow call and carried on, or whose history doesn't fit its workflow:
it [ends in `error`](/run/runs/#durability) as the new version starts, saying why, and none of its
steps runs again. A restart treats it the same
way. Let those runs finish first, or run them again after. Runs v0.2.25 or later started resume where
they were, through later restarts and upgrades.

The boot log counts the runs v0.2.24 or earlier started that are in flight, for example
`Runs v0.2.24 or earlier started, in flight at boot: 3 can resume, 1 can't be resumed safely and will fail, 0 had already ended`,
and names each one that fails at warn level with its reason, followed by a `RunNotResumable` error
and its stack trace: that is the run ending, not the service failing. Runs v0.2.25 or later started
are not counted there: they resume where they were, so only a run v0.2.24 or earlier started is
judged this way. From v0.2.24 on, you can list them before you restart or upgrade:

```bash
cd sarati && docker compose exec sarati sarati-legacy-report
```

It only reads, and prints each run v0.2.24 or earlier started that is in flight as `would resume`
or `would fail` with the reason, or `already ended` for one that had finished or been cancelled but
not yet stopped, which stays as it ended. A run can still move on between the report and the
restart, so each is judged again as it resumes. On a five-container install it is
`docker compose exec service` instead; running it by hand, `docker exec sarati`.

### Going back

Set `SARATI_VERSION` to the earlier version and upgrade again. Running it by hand, name the version
on the image in both commands, `sarati/sarati:0.2.26` for example. What carries on there depends on
the version you go back to.

**To v0.2.26 or v0.2.25**, runs carry on as they do here: both resume a run this version started, on
the same engine. Its approvals stay listed and answerable there, a **Wait** step wakes there, a step
it was running when you went back runs again there, and coming back to this version picks it up
where it was.

**To v0.2.24**, a run v0.2.25 or later started doesn't carry on: v0.2.24 logs at boot that it can't
recover it. It stays in flight there: its approvals stay listed, and a decision made there is taken
when you come back to this version, which picks the run up where it was. Three things end it there in
an error, and coming back leaves it that way, running nothing more: an approval whose window passes, a
**Wait** step still parked `RUN_MAX_DURATION_SECONDS` after its time is up, and a step it was running
when you went back, once the run has been in flight for `RUN_MAX_DURATION_SECONDS`. Come back before
any of them to keep such runs: a **Wait** step whose time came while you were away then wakes.

**To v0.2.23 or earlier**, a run v0.2.25 or later started doesn't carry on either: let those runs
finish before going back that far. A run v0.2.24 or earlier started carries on there, and keeps its
waits only if none of them runs beside another step: approvals that come one after another, even on
the same topic, and a wait inside a loop. Let any such run with parallel branches, or with steps that
start side by side, finish before going back, even when only one of its approvals shows in the inbox.
There it can lose that approval, put a decision on the wrong wait, or end in an error. So can a run
with two approvals on one topic, neither waiting for the other, when the **If** and **Switch** steps
before either of them have more than 4096 combinations of routes, even if the two never wait at the
same time.

For a run that keeps its waits there:

- Its approval stays listed and answerable, and a **Wait** step still wakes.
- A decision made here that the run had not taken yet is applied there, but is not recorded with who
  made it. If it had not even gone out, because the service stopped as it was made, its wait is
  listed there to decide again.
- It shows one decider per run: whoever answered its last approval. A run with several approvals
  shows only that one there, and coming back to this version shows each on its own step again.
- The time it spent parked counts against `RUN_MAX_DURATION_SECONDS` there, so a run that resumed
  from a long wait may end in an error.
- Coming back to this version picks it up where it was left.

A step with no account chosen fails there: those versions need an app step to name an account, even
under an environment, where the environment's account is still the one it runs as. A run on Default
and **Test this branch** fail the same way. Pick an account on the step, and promote that version
again for an environment to run it. An AI Agent step is the exception under an environment: there it
runs as the environment's account with or without one.

**Triggers, going back to v0.2.25 or earlier.** None of them holds a trigger whose environment's
account isn't active: there such a trigger is polled as that account, and a change a promote left
waiting for it is tried at its app as that account. A webhook delete waiting for its account to be
active again is tried there with that account from v0.2.23 to v0.2.25, which give up one the app
refuses that account for: the log names the webhook at warn level, so you can delete it in the app.
Earlier versions never try it. Coming back, this version judges every app trigger by its
environment's account again when it starts, without waiting for a sweep: one whose account isn't
active is held, one held whose account is active again listens again, and one held back for an
account that is active again is set up with that account.

**Personal workspaces, going back to v0.2.26 or earlier.** Accounts are made there as here, each with
a personal workspace of its own, and the database still holds each to one member, its owner. Those
versions still let an owner invite someone into it through the API, but nobody joins: accepting the
invite answers `500`, and a sign-up with it makes the account and then answers `500` without
joining. Coming back, the upgrade deletes each such invite (`044 deleted the pending invite …`).

**Environments, going back to v0.2.26 or earlier.** Those versions make environments you didn't
create. Every start there makes one for each name a
[cluster connection](#an-environment-is-made-only-by-creating-it) gives that the workspace doesn't
have, one you deleted or renamed here included, and puts the connection in that environment's slot
for its app when the slot is empty. Listing a workspace's environments there makes `staging` again
where you deleted or renamed it, and a promote to a name the workspace doesn't have creates it.
Coming back keeps what they made: delete those environments, or empty those slots, under
**Integrations → Environments**.

**Going back to v0.2.25 or earlier** also undoes everything else
[v0.2.26 changed](#v0226-the-service-opens-no-port-but-its-own). Above all, with durable runs on, the
images' default, the service opens the DBOS admin API on port 3001 again, on every interface: it
answers without signing in, and can cancel, resume or fork any run. Neither stack file nor the
one-container image publishes that port, but any container on the same Docker network can reach it,
and so can anything that reaches the machine when the service runs outside Docker. That is the flaw
[GHSA-33cr-cppq-j5hp](https://github.com/saratihq/sarati/security/advisories/GHSA-33cr-cppq-j5hp)
describes, and the installer warns when it starts such a version.

## Notes for specific versions

### v0.2.27

**Five containers: re-run the installer.** The stack file changed: with the new `docker/Caddyfile`,
the proxy logs each request as its time, status and visitor's address alone — never the address asked
for, its headers or where it was redirected, which can carry an invite link, a webhook address or a
sign-in callback's code. Only the installer refreshes that file, and it restarts the proxy to load it,
so `docker compose pull` alone is not enough this time. One container gets the same from the new
image. Lines the proxy wrote before go with the container it replaces, unless Docker sends its logs
somewhere else, where they still hold those addresses.

#### Sign in through your own identity provider, and invites for one address

People can now sign in through your own OpenID Connect provider — see
[Single sign-on](/operate/configuration/#single-sign-on).

What changes for every instance:

- **An invite admits only the account at the address it was sent to.** Earlier versions let any
  signed-in account holding the link join. Another account is now refused with `403` and the code
  `invite_email_mismatch`, and the invite stays pending; a pending invite still works for its own
  address. Someone whose account has another email needs an invite to that one —
  [Users](/operate/users/#invite-someone).
- **One account holds each email, in any letter case.** Earlier versions kept two accounts apart
  when their emails differed only in letter case, as Clerk or an identity-provider token could make
  them. The upgrade leaves the address to the one already in lower case, or else the older, and the
  upgrade log names the other on a line ending `an invite to it goes to the other`; that account
  keeps everything else. Password sign-in finds an account by its email in any letter case.

What changes for an instance that had `OIDC_*` set:

- **An identity provider's token is no longer an API credential.** Earlier versions accepted one
  sent as `Authorization: Bearer`, made an account for any subject it named, and needed only
  `OIDC_ISSUER`. It is now refused with `401` and the code `token_rejected`. Scripts and integrations
  that sent one switch to [API keys](/agents/api-keys/).
- **`OIDC_JWKS_URL` and `OIDC_AUDIENCE` are no longer read:** the boot log warns about each until
  you remove it. `OIDC_ISSUER` on its own does nothing, and the boot log says so until you add
  `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
- **Accounts that path made are not connected for you.** Connect them before their owners sign in:
  `sarati-link-sso --list` names each one with the subject the old path stored, and
  `sarati-link-sso --all` connects every one to it
  ([Connecting accounts from the server](/operate/users/#connecting-accounts-from-the-server)). The
  boot log counts the accounts still waiting. Otherwise a first sign-in is refused as "You already
  have an account", or, for an account the old path gave an `@oidc.local` address, makes a second,
  empty account — which `sarati-link-sso <email> --move` sets right.

What changes once you set the three `OIDC_*` values:

- **Email and password turns off,** and password sessions already issued stop working at the
  restart. Set `LOCAL_AUTH_ENABLED=true` to keep passwords while people
  [move over](/operate/users/#single-sign-on).
- **The redirect URI is fixed:** `<SARATI_URL>/auth/oidc/callback`, registered at your provider.
- **Clerk and your own provider cannot both be set:** `CLERK_ISSUER` with `OIDC_CLIENT_ID` stops
  the service at boot. Moving from Clerk means connecting each account to its subject at the new
  provider — [Switching from Clerk](/operate/users/#switching-from-clerk).

#### Signing up with an invite makes an account only by joining

There is nothing to change on upgrade. What a caller of `POST /api/auth/local/register` sees
change:

- **A sign-up with an invite makes its account in the same step as joining.** When the invite is
  revoked or accepted by another account, or its organization deleted, while the sign-up is under
  way, the sign-up is refused with `403` and the code `signup_closed` and makes no account. It used
  to make the account and then answer `404`, leaving an account no invite had let in. A revoke that
  reaches the invite while a sign-up holds it waits for it, and once the sign-up lands answers `404`
  as for an accepted invite. See [Invite someone](/operate/users/#invite-someone).
- **A sign-up carrying an invite token on an instance with no accounts yet is judged by that
  invite.** One that names no invite is refused with `403` `signup_closed`, and the instance still
  waits for its first account. It used to make the owner account and then answer `404`.
- **Sign-ups take turns.** Two first sign-ups at once on an empty instance make one account, and the
  other is refused with `403` `signup_closed`; both could get in before. Two sign-ups of one email at
  once make one account, and the other answers `409` `email_taken`, or `403` `signup_closed` on an
  empty instance, which the first account closes; it used to answer `500`.

#### A personal workspace has one member: its owner

Earlier versions let the owner of a personal workspace invite people into it through the API, though
the app never offered it, and the invite joined them to it. A personal workspace is now its owner's
alone, and the database refuses a second member. The upgrade sets right one someone else joined.
Each thing it does is a warning in the upgrade log, on a line starting `044`:

- **It keeps only the owner, as owner.** Every other member is removed (`044 removed …`). The
  workflows they created there, with their runs and any approvals still waiting, stay in the
  workspace with its owner. The removed member can no longer open any of them, and nothing moves a
  workflow from one workspace to another. Each `044 removed …` line gives the number of workflows
  that member created there. An earlier version could file a member's work under "Personal" in this
  workspace without their choosing, so a non-zero count is worth raising with them. An owner a
  member had demoted gets the role back (`044 gave … back the owner role …`), and one a member had
  removed is added back (`044 added … back …`). The owner is the account the workspace was made for,
  worked out from its records, never someone an invite let in.
- **It empties each environment slot there filled with a removed member's connection**
  (`044 emptied the <app> slot of environment <name> in personal workspace <id>: it held connection
  <id> of <email>, …`). A step or trigger that ran as that account in that environment stops until
  the owner assigns an account of their own to the slot.
- **It revokes each API key a removed member had pinned to it** (`044 revoked API key …`). A key
  they make now acts in their own workspace.
- **It deletes the pending invites into it** (`044 deleted the pending invite …`).

Two rarer cases: a personal workspace no account can be shown to own, or a second one an account came
to own, becomes a shared organization and keeps its members (`044 made personal workspace … a shared
organization …`), and every API key pinned to it is revoked (`044 revoked API key … that is now a
shared organization`): a new key is pinned only to its holder's personal workspace, so its members
reach the organization by signing in. And an account left with no personal workspace gets one, with
production, staging and uat (`044 gave … a personal workspace of its own …`).

To find what it emptied, revoked and removed after upgrading:

```bash
cd sarati && docker compose logs sarati | grep '044 '
```

On a five-container install it is `docker compose logs service`; running it by hand,
`docker logs sarati`. A second boot changes nothing and logs none of these.

What a caller of the API sees change:

- **An invite into a personal workspace is refused**, for every role, with `400` and
  `The personal organization has no other members`, as transferring its ownership already was. So
  are changing a role there, removing someone and leaving.
- **An invite into a personal workspace an earlier version made answers as a spent one** wherever it
  is still held: a preview or an accept `404`, a sign-up with it `403` `signup_closed`, and a first
  single sign-on with it makes the account and joins nothing.
- **`GET /api/orgs` marks only your own personal workspace `is_personal`**, and lists it first. A
  request with no `X-Org-Id` acts in it, with the role your membership holds.
- **A new API key is pinned to your own personal workspace.** An account with none is refused one
  with `409`.

Going back to v0.2.26 or earlier still makes accounts there; what else changes for personal
workspaces is under [Going back](#going-back).

#### An environment is made only by creating it

A workspace starts with `production`, `staging` and `uat`, and an owner or admin adds, renames and
deletes environments under **Integrations → Environments**. Nothing else makes an environment or
brings one back. See [Environments](/run/environments/).

What changes:

- **A promote to a name the workspace doesn't have answers `404` and creates nothing.** It used to
  create the environment, so a promote to a deleted `staging`, to `default` or to a typo made one.
  The refusal has the code `environment_not_found` and says to create the environment under
  Integrations → Environments first; for `default` it says the name belongs to the connection pool. `POST /api/workflows/<id>/promote` takes `environment_id`, the
  environment's `id`, which a rename doesn't change; a name in `environment` still works, in any
  letter case, and `prod` still reaches `production`. See [Promote](/run/environments/#promote).
- **Listing environments no longer makes any.** Earlier versions made each of `production`,
  `staging` and `uat` a workspace lacked whenever its environments were listed, as
  Integrations → Environments does, so a deleted or renamed `staging` came back. The upgrade gives
  each workspace whichever of the three it never had, once, leaving out a `staging` it deleted or
  renamed.
- **The cluster connect route, `POST /api/orgs/<id>/clusters/<env>/connect`, is removed** and
  answers `404`. It connected an account for one environment of an organization, a cluster
  connection. Cluster connections an earlier version made are still listed by
  `GET /api/orgs/<id>/clusters`, still run from any environment slot that holds them, and can still
  be deleted with
  `DELETE /api/orgs/<id>/clusters/connections/<connection-id>`. To give an environment an account,
  connect it under **Integrations** and assign it to the environment's slot under
  **Integrations → Environments**.
- **A restart no longer brings back an environment a cluster connection still names, nor refills a
  slot an owner emptied.** Earlier versions read the environment name on each cluster connection at
  every start: an environment of that name the workspace didn't have was made, one you had deleted
  or renamed included, and the connection went into that environment's slot for its app whenever
  the slot was empty.

After upgrading:

- **What an earlier version made by mistake stays:** a deleted `staging` that a list, a restart or a
  promote brought back, a `default` or a typo that a promote or a restart made, and a slot a restart
  filled again after an owner emptied it. Delete the environment, or empty the slot, under
  Integrations → Environments.
- **A cluster connection made since the instance last started on an earlier version is not put in
  its environment's slot** by this upgrade, as the next restart there would have done, and no
  environment is made for a name it gives that the workspace doesn't have. Add the environment if
  the workspace lacks it, then assign its slot an account under Integrations → Environments.

#### A TypeScript Code step may await and return

A **Code** step written in TypeScript runs as the async function body its editor describes, so one
snippet may both `await` and `return`. Earlier versions refused such a step with
`Top-level return cannot be used inside an ECMAScript module`, both when a run started and when a
version with it was saved. TypeScript is still type-stripped, not type-checked: a type error runs as
JavaScript, and only a syntax error is refused.

What a caller of the API sees change:

- **A TypeScript Code step is read as a function body, so what only a module's top level allows is
  refused** where it used to run, as a run starts, with `400` and the code `compile_failed`, and as a
  version with it is saved: a `namespace` or `module` block, `declare module`, `import x = N.y`,
  and, in a step with no `return`, an `import type`, `export type` or `export interface` line.
  Write a namespace's contents as plain declarations, and drop type-only imports and exports. A step
  whose first line starts with `#!`, which always failed as it ran, is refused the same way.
- **A TypeScript syntax error names the line and column in the step's own code**, both counted from
  1, as in `Code node "calc" has a TypeScript syntax error at line 2, column 28: Unexpected "="`, and
  says `at the end of the snippet` for one left unclosed. It used to read
  `has a TypeScript error: Error: Transform failed with 1 error: <stdin>:2:29: ERROR: Unexpected "="`,
  its column counted from 0 and in bytes.

#### Webhooks take form fields and text

A webhook, a test-event catch and a chat now read the body by its `Content-Type`, so form fields and
text reach the run, and a signature is checked over the body's bytes whatever its type. See
[What the run receives](/build/triggers/#what-the-run-receives).

What a caller of the API sees change:

- **Form fields, text and any JSON value reach `{{trigger.body}}`.** A body sent as
  `application/x-www-form-urlencoded`, `text/*`, XML or a `+json` type used to start a run with
  nothing in `{{trigger.body}}`, and a bare JSON value such as `42` or `"ping"` was refused with
  `400`. A body with no `Content-Type` is read as UTF-8 text, where it was dropped too. A chat takes
  `chatInput` and `sessionId` as form fields, or the message as text.
- **A correctly signed form or text delivery is accepted.** It used to be refused with `401`,
  because its signature was checked over no bytes. An empty signed JSON body is now checked over no
  bytes, where it was checked over `{}`.
- **A body Sarati can't read is refused with `415`, and nothing runs**, where it used to start a run
  with nothing in `{{trigger.body}}`: `application/octet-stream`, `multipart/form-data` and any other
  type not listed, a `charset` it doesn't know, and a body with no `Content-Type` that isn't UTF-8.
  A sender that can only post `multipart/form-data`, such as an inbound-email service, can't start a
  run. See [A webhook returns 415](/operate/troubleshooting/#a-webhook-returns-415).
- **A request whose body can't be read answers with what went wrong, on every route,** where it
  used to answer `500`: a `Content-Encoding` other than `gzip`, `deflate` or `br`, for one, answers
  `415 unsupported content encoding "…"`.
- **Invalid JSON sent to a webhook or chat answers `400`** and says the body is not valid JSON,
  where the detail used to be the parser's message.
- **An empty body leaves `{{trigger.body}}` empty**, where an empty `application/json` body made it
  `{}`.
- **A GitHub delivery sent as form fields is its event:** `{{trigger.body}}` is the event, as when it
  is sent as JSON, where it used to be empty.
- **A caught test event is the trigger as a run sees it.** `GET /api/catch/:id` returns `payload` with
  the body at `body` and an object's fields beside it, where it returned the body alone.

### v0.2.26: the service opens no port but its own

The service listens on its `PORT` alone. Earlier versions, with durable runs on (`DBOS_ENABLED`, the
images' default), also opened port 3001 on every interface for the admin API of DBOS, the library
that makes runs durable. That API answers without signing in: it lists runs with what each started
with and every step's output, and cancels, resumes or forks any run. Neither stack file nor the
one-container image publishes the port, but any container on the same Docker network could reach it,
and so could anything that reaches the machine when the service runs outside Docker. Nothing in
Sarati used it, so it needs nothing from you. The advisory is
[GHSA-33cr-cppq-j5hp](https://github.com/saratihq/sarati/security/advisories/GHSA-33cr-cppq-j5hp).

What a caller of the API sees change:

- **Testing a branch under an environment takes the right to promote there.** In an organization
  only owners and admins have it, and an API key needs `workflow:deploy` as well as `run:execute`,
  in a personal workspace too. Without it the test answers `403` with the code
  `promote_not_permitted` and nothing runs; testing on Default is unchanged. A promote, publish,
  restore or un-promote refused for a member's role now carries the same code. See
  [Who can promote](/run/environments/#who-can-promote).
- **Promoting, publishing or restoring checks each app trigger against the environment's account
  for its app,** as it checks each step. Before, it refused only a trigger that named an account of
  its own where the environment had none assigned. A version whose trigger the account can't serve —
  there is none, it is for another app, it isn't active, or it is of the wrong kind — is refused with
  `428`, the trigger listed under `triggers`. A trigger already live on such an account stops
  listening at the first fifteen-minute sweep after the upgrade, when pg-boss is enabled (the
  default), and the workflow overview shows it as **Not listening** with the reason; one whose
  account only stopped being active is **held** instead,
  keeping what it set up at the app. A change to an account reconciles the triggers that listen as it
  straight away. The refusal for an account that isn't active now says its owner tests it under
  Integrations, where it used to say to reconnect it: **Reconnect** connects a new account, which
  the slot holds only once an owner assigns it. See
  [Triggers listen as the environment's account](/run/environments/#triggers-listen-as-the-environments-account).
- **Renaming an environment is refused with `409`** while one of its webhook triggers is registered
  with an account that isn't active, each listed under `held_webhooks`. No webhook delete is sent
  with such an account either: it waits until the account is active again. See
  [Rename and delete](/run/environments/#rename-and-delete).
- **Every request carrying the Composio API key follows a redirect only while it stays on the same
  origin.** One to another origin fails the call without retrying and names where it pointed, and
  neither the key nor the request reaches it. A managed step used to follow it there, key and all,
  and the service's own calls to Composio, such as a connect link, followed no redirect at all. See
  [the message](/operate/troubleshooting/#a-managed-step-says-composio-redirected-it-elsewhere).
  A username or password in `COMPOSIO_BASE_URL` or `CLERK_API_URL` now stops the service at boot;
  see [What survives](#what-survives).
- **Deleting an environment just after promoting into it** removes the new trigger with the others.
  It could answer `409` and leave that trigger set up at its app until a later reconcile.
- **A delete that crosses another write ends as if the two ran one after the other.** Deleting a
  workflow, an environment or an organization while another delete, or a write under the same
  organization, was under way could fail on a deadlock or with a `500`. Now they take turns: a write
  already under way lands first and the delete sees it, and a write that reaches what the delete
  holds waits for it, then answers `404` if what it changes is gone. A revoke and an accept of one
  invite, or two accepts, take turns the same way, so an invite admits one account.

### v0.2.25: runs with parallel branches resume as they ran

Runs this version starts resume after a crash, a restart or an upgrade where they were, parallel
branches included. A run an earlier version started goes on as [v0.2.24](#v0224-moving-to-this-version)
describes.

What a caller of the API sees change:

- **A raw plan's node ids keep to the rule a saved workflow's do:** letters, digits, `_` and `-`, at
  most 60 characters, starting with a letter or digit. `POST /api/runs` and `POST /api/runs/async`
  refuse a plan with any other id with `400` and the code `compile_failed` before any step runs.
- **A document handed to `POST /api/runs/from-ir`, to `POST /api/runs/async` as `workflow_ir`, or to
  MCP's `orchestr_test_workflow` is checked as a save checks it.** One with a step type no catalog
  knows, or an id outside that rule, is refused before any step runs.
- **A step in an error lane is keyed under the step that failed into it**, as `<that step's id>#error/<its
  id>`: in a run's `steps[].step_key`, in its waits in the inbox, and in a decision aimed at a
  `step_key`. A run an earlier version started keeps the keys it had.
- **A delay of 10 to 60 seconds ends within about ten seconds of a cancel**, where it used to run out.

### v0.2.24: moving to this version

**Five containers: re-run the installer.** The stack file changed — part of the rate-limit fix below
is in `docker-compose.yaml` and `docker/Caddyfile`, which only the installer refreshes — so
`docker compose pull` alone is not enough this time. One container needs only the new image.

**A run that can't be resumed safely now ends in an error when it resumes** — one that had already
run steps side by side, whose AI Agent step was refused a sub-workflow call and carried on, or whose
history doesn't fit its workflow. It
used to resume, and could then put a step's result or a decision in the wrong place, or end in an
error later. The runs in flight as you upgrade are judged the same way when this version first
starts, and its boot log says how many will fail. Earlier versions can't list them for you, so let
runs with parallel branches, and AI Agent steps that call workflows, finish before upgrading.

A few saved steps that ran before now stop with an error before sending anything, because they
could act on the wrong Jira site or send a credential somewhere it does not belong. Check the
workflows that use them before you upgrade; each fix is one field on the step.

- **A managed Jira step with a blank Instance URL, on a connection that reaches two or more sites,**
  used to run on the first of them. It now refuses and lists the sites: set Instance URL to the one
  to use.
- **A managed Jira step whose Instance URL names a site the connection can't reach,** such as
  `https://old.atlassian.net`, used to run on the connection's first site instead. It now refuses and
  lists the sites the connection can reach: set Instance URL to one of them.
- **A managed Jira step whose Instance URL is not a Jira Cloud host,** such as a self-hosted
  `https://jira.acme.com`, used to have it ignored. It now refuses: set Instance URL to your Jira
  Cloud site, `https://<your-site>.atlassian.net`.
- **A Salesforce step or trigger whose Instance URL is a legacy instance host** —
  `na123.salesforce.com`, a `cloudforce.com` host or an Experience Cloud `my.site.com` host — now
  refuses to send its credential there. Set Instance URL to your org's My Domain URL,
  `https://<your-domain>.my.salesforce.com`.

The messages and what to set are in Troubleshooting:
[a Jira step](/operate/troubleshooting/#a-jira-step-refuses-its-instance-url) and
[a Salesforce step](/operate/troubleshooting/#a-step-wont-send-its-connections-credential).

Rate limits now count per visitor — an IPv6 visitor per `/64` — and the AI composer's calls count
against the visitor who made them. Before, the service saw Sarati's own proxy as every visitor, so
they all shared one limit: one person's failed sign-ins locked everyone out, and anyone could switch
the composer off for everybody.

- **Behind another proxy** — Cloudflare, a load balancer, a Cloudflare Tunnel — list it in
  `SARATI_TRUSTED_PROXIES`; [Behind another proxy](/operate/configuration/#behind-another-proxy) says
  how.
- **`TRUST_PROXY_HEADERS` is replaced:** remove it from `.env`. With Sarati's own proxy it is ignored —
  a leftover `true` is reported in the boot log, a leftover `false` silently. `TRUST_PROXY_HOPS` is only
  for the images run without that proxy.
- **One container answers on 8080 only:** its service (8001) and composer (8010) now listen inside the
  container alone, so reach everything — the MCP endpoint included — through port 8080.

`COMPOSIO_FALLBACK_APPS` is removed. In v0.2.23 and earlier it only changed where a listed app's
step went when its type was neither a built-in action nor in the Composio catalog, and saving a
workflow refuses such a type, so nothing changes for a step a workflow can save. If the variable is
still set, the service logs one warning at boot and otherwise ignores it; delete the line from
`.env`.

### v0.2.23: outbound requests to private addresses

Every step and trigger that calls an address from this server now refuses a private or internal one,
in any spelling, on every redirect. Before, the HTTP and GraphQL steps, the HTTP and RSS triggers and
the OAuth token exchange checked the address once before sending — not the address actually connected
to, any redirect, or an IPv6 spelling of an IPv4 address, which let a private address through. Upgrade
from any earlier version.

What can newly refuse, and the fix for each, is in
[Private addresses](/operate/configuration/#private-addresses):

- app steps on your own credentials aimed at a host on your network
- redirects into private space
- an OAuth client entered in the Connect dialog whose host this server cannot resolve
- a server whose DNS hands out synthetic private addresses

Steps behind an egress proxy go through it when Node's `NODE_USE_ENV_PROXY=1` is set; keep the
stack's own addresses in `NO_PROXY`, as
[Private addresses](/operate/configuration/#private-addresses) lists.

## What survives

Everything in the volumes: workflows, versions, branches, reviews, runs, users, and stored
credentials. Removing a container removes nothing you care about. An upgrade keeps the same workflow
count and leaves connected accounts `active`, because the `FERNET_KEY` it already had still decrypts
them.

**Upgrading from v0.2.22 or earlier** starts every live trigger over once, as the upgraded service
starts: webhooks registered with an app are deleted and registered again, subscriptions are renewed,
polled triggers start from that moment, and schedules restart their interval. An item that arrives
between a polled trigger's last check and that moment may not start a run. Earlier releases did not
record what each trigger had registered, so this is the one time it is rebuilt from scratch. If an
earlier release changed an app-webhook trigger into a different kind of trigger, or emptied the
environment slot one ran on, the webhook it left registered can't be deleted for you: the service
log names it at warn level after that first rebuild, at the latest on the fifteen-minute sweep that
follows it, so you can delete it in the app. A webhook that an earlier release replaced after the
slot moved to another account, or after a GitHub trigger's repository changed, was never recorded,
so it is neither deleted nor named in the log: look in the old account or repository for webhooks
that point at this install, and delete them there.

**Upgrading from v0.2.22 or earlier** with `COMPOSIO_BASE_URL` set to a plain `http://` address on
another host stops the service at boot: every request to it carries the Composio API key, so it has
to be `https://`, or `http://` to the same machine. A value that isn't an http(s) URL, or that
carries a `?` or `#`, now stops it at boot too — neither ever sent a request to the right path.

**Upgrading from v0.2.25 or earlier** with a username or password in `COMPOSIO_BASE_URL` or
`CLERK_API_URL` stops the service at boot, and the message names only the address and path. Take
them out of the URL: neither was ever sent. Requests to the Clerk API and to the Composio API
dropped them, and with them in `COMPOSIO_BASE_URL` every managed step failed with an error that
repeated them.

## Back up

Your install is one container or five — `docker compose ps` in the `sarati` directory tells you
which. It matters here and almost nowhere else.

### One container

Everything lives in one volume, so the complete backup is that volume. Stop it first: a database
copied while it is running is not a consistent copy.

```bash
cd sarati && docker compose stop
```

```bash
docker run --rm -v sarati_data:/data -v "$PWD":/backup alpine tar czf /backup/sarati-data.tgz -C /data .
```

```bash
docker compose start
```

Restore by unpacking into a fresh volume and pointing an install at it:

```bash
docker run --rm -v sarati-restored:/data -v "$PWD":/backup alpine tar xzf /backup/sarati-data.tgz -C /data
```

```bash
docker run -d --name sarati -p 8080:8080 -v sarati-restored:/data sarati/sarati
```

**Without downtime**, dump the database and copy the keys out instead. This covers workflows,
versions, users and credentials, but not the checkpoints of runs that are in flight — those live in
a second database the dump does not reach.

```bash
cd sarati && docker compose exec sarati pg_dump --clean --if-exists --exclude-schema=pgboss -h 127.0.0.1 -U sarati sarati > sarati-backup.sql
```

```bash
docker compose cp sarati:/data/secrets.env sarati-secrets.env
```

**The dump is useless without that second file.** It holds `FERNET_KEY`, and no other key can
decrypt the credentials inside the dump.

Load one back, then restart so the engine reconnects:

```bash
docker compose exec -T sarati psql -h 127.0.0.1 -U sarati sarati < sarati-backup.sql && docker compose restart
```

### Five containers

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

Restore by stopping the stack, putting the `.env` back, bringing the database up on its own, and
loading the dump:

```bash
cd sarati && docker compose down
```

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
