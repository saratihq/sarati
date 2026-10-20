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

## A promote or publish says a trigger or step "can't run there"

```
staging's gmail account isn't active, so "New email" can't run there — its owner tests it under
Integrations once it works again, or an owner reassigns the slot under Integrations → Environments
before promoting here
```

The environment's account for that app can't serve what the message names: there is none, it is for
another app, it isn't active, or it is of the wrong kind — one that uses its own credentials where
only a one-click account runs the trigger or step, or a one-click one for a trigger that signs in
with its own. A trigger listens as the environment's account even when it names one of its own, so
picking an account on the trigger does not help. Fix the slot under
**Integrations → Environments** and promote again. **Reconnect** under Integrations connects a new
account, which the slot holds only once an owner assigns it there.

The same reason on the workflow overview, under **Not listening**, means a trigger is held back by
the environment's account, and starts once the slot is fixed. A trigger whose own account stopped
being active is **held** as it was, and the overview's reason says what it still does: a polled feed
is not listening and picks up from where it stopped once a **Test** under Integrations finds that
account working, while a webhook or subscription still starts a run for each delivery. See
[Environments](/run/environments/#triggers-listen-as-the-environments-account).

## A run ends in `error`

The run and the failing step both carry the reason, for example
`http.send_request failed: HTTP 500`. There is no retry button — see
[Runs](/run/runs/#when-a-step-fails) for the three things that do exist.

## A run is stuck `running`

If the worker came back, it resumes on its own. If it never comes back, the reaper moves the run to
`error` once it has been in flight for `RUN_MAX_DURATION_SECONDS` since it started or last resumed
from a wait, within five minutes.

## A run reads "…so it can't be resumed safely — run it again."

The service stopped — a restart, a crash or an upgrade — and resuming the run could have put a step's
result or a decision in the wrong place: it had run steps side by side, an AI Agent step in it was
refused a sub-workflow call and carried on, or what it recorded does not fit its workflow. The
message says which. Nothing in it ran again: each step it had under way reads *Stopped when the
service did*, and a decision it had not taken yet is recorded on its wait, with who made it, but not
applied. Run the workflow again. The service log names the run at
warn level with the reason, followed by a `RunNotResumable` error and its stack trace: that is the
run ending, not a fault in the service.
[Durability](/run/runs/#durability) says which runs this happens to, and
[Upgrades](/operate/upgrades/#upgrade) how to list them before a restart.

## A decision is refused: "Run … has stopped, so a decision can no longer reach it"

The run is still listed as waiting, but its workflow is no longer running, so nothing can take a
decision: it is refused rather than recorded. That happens when the service gives up on the run as
it recovers it:

- the recovery guard could not read the run's history and gave up after 40 tries, logging
  `Couldn't read the history of run … in 40 tries`. That covers errors such as a lock held on the
  history's tables; while the database can't be reached at all, the read waits instead, and DBOS
  logs `Database connection failed` as it tries again.
- DBOS gave up recovering the run after too many attempts.

The run stays listed until its wait's window passes; then the reaper ends it in `error` with
*Approval window expired before a decision was recorded.* Run the workflow again.

A run a later version started is never refused this way after going back to this one: its decision
is recorded here, and the run takes it once you upgrade again.

## A run reads "Decided by … the run has yet to take it"

Someone decided, and the decision is waiting for the run to pick it up — the run is down, or catching
up after a restart. It is sent again until the run takes it. If the run can never resume here, the
reaper ends it once the wait is past its window by `RUN_MAX_DURATION_SECONDS`, with an error naming
who decided; run the workflow again.

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

## A step refuses a private/internal address

```
http.send_request failed: refusing to send a request to a private/internal address (wiki.internal). An operator can allow it by adding wiki.internal to ORCHESTR_HTTP_ALLOWED_HOSTS.
```

The address resolves to somewhere that is not public, so the step was stopped before anything was
sent. If it is a host you mean to reach, add the name in the parentheses to
[`ORCHESTR_HTTP_ALLOWED_HOSTS`](/operate/configuration/#private-addresses) — the hostname alone, no
scheme or port — then run `docker compose up -d`; restarting the container is not enough. When the
parentheses also say `redirected from https://…`, the address you gave was reached and answered with
a redirect into private space, which was not followed; the host named first needs its own entry.

```
the egress proxy refused the tunnel to https://api.example.com (403)
```

The step went through your egress proxy, which would not open a tunnel to the address this server
resolved. A proxy that filters by domain name refuses tunnels to addresses; allowlist the domains it
should see so they reach it by name, as
[Private addresses](/operate/configuration/#private-addresses) describes.

If every app step on your own credentials is refused, including ones aimed at public services, this
server's DNS is probably handing out synthetic private addresses (a fake-IP proxy or ZPA). The
[Private addresses](/operate/configuration/#private-addresses) section covers that, egress proxies,
and what an entry exposes.

## A step won't send its connection's credential

```
salesforce.run_query failed: refusing to send this connection's credential to https://na123.salesforce.com — it is only sent to https://*.my.salesforce.com, https://*.salesforce.mil, https://*.sfcrmproducts.cn
```

A connection's credential only ever goes to its own app's domains, the ones the message lists, so
the step was stopped before anything was sent. `ORCHESTR_HTTP_ALLOWED_HOSTS` does not change this.
Point the step at the app's own address:

- **Salesforce:** set **Instance URL** to your org's My Domain URL,
  `https://<your-domain>.my.salesforce.com`. A legacy instance host such as `na123.salesforce.com`,
  a `cloudforce.com` host or an Experience Cloud `my.site.com` host is refused.

## A Mailchimp or Zendesk step refuses its server prefix or subdomain

```
mailchimp.list_audiences failed: serverPrefix must be a single DNS label (letters, digits and hyphens), e.g. "acme"
zendesk.list_tickets failed: subdomain must be a single DNS label (letters, digits and hyphens), e.g. "acme"
```

The step builds the app's address from this one field, so anything more than a single label, such as
a whole hostname, is refused before anything is sent:

- **Mailchimp:** set **Server prefix** to the datacenter alone, such as `us21`: the suffix on your API
  key, not a hostname.
- **Zendesk:** set **Subdomain** to the subdomain alone, `acme` for `acme.zendesk.com`.

## A Jira step refuses its Instance URL

```
jira.get_issue failed: instanceUrl "https://jira.acme.internal" is not a Jira Cloud site — use e.g. https://your-domain.atlassian.net, https://your-domain.jira.com or https://your-domain.atlassian-us-gov-mod.net
```

Jira steps run against Jira Cloud only. Set **Instance URL** to your Jira Cloud site URL,
`https://<your-site>.atlassian.net`.

On a managed connection, the step also refuses to guess between sites:

```
jira.get_issue failed: this connection can reach several Jira sites (https://acme.atlassian.net, https://beta.atlassian.net) — set instanceUrl to the one to use
```

```
jira.get_issue failed: instanceUrl https://old.atlassian.net is not a site this connection can reach — it can reach https://acme.atlassian.net
```

Set **Instance URL** to one of the sites the message lists.

## A step says it has no account to run as

```json
{"detail":"Step \"List channels\" has no slack account to run as — connect one"}
```

Connect the app; the step runs as it. If it says you have two accounts for the app, pick the one the
step runs as on the step. If it says its account no longer exists or isn't yours, the account picked
on the step was removed, or belongs to a teammate — pick one of yours. If it says its account is for
another app, the account picked on the step connects a different app — pick one for this one. If it
says its account isn't active, the sign-in picked on the step was never finished or has expired —
pick another of your accounts for the app on the step. If it says the step runs only on a one-click
(managed) account, its action runs only through one-click sign-in — connect the app that way, and
pick that account if the step names another. See [Connections](/build/connections/#using-one-in-a-step).

Under an environment the message names it instead —
`production has no gmail account assigned, so "Email me the report" can't run there`,
`production's gmail account is for slack`, `production's slack account uses its own credentials`, or
`production's gmail account isn't active` — and an owner assigns or reassigns one under
**Integrations → Environments**. An account that isn't active is also mended by its owner
reconnecting it under **Integrations**.

## An AI Agent step says it has no Claude account

```json
{"detail":"Step \"Agent\" has no Claude account to run as — connect one under Integrations → \"Use your own credentials\" → Claude. The Anthropic key in Settings → Platform keys powers the AI composer only, not agent steps"}
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
Target branch is protected — the pre-merge test is failing (a step errors on this branch that passes on the target). Commit a fix, or re-test once the cause is resolved. The latest conclusive test of these versions is on review "Raise the limit" (lane → main). It failed with: …
```

Also intended: the latest conclusive test of exactly these two versions found a step that errors on
your branch but not on the target. If the review that ran it was on a branch since deleted, the
message says so instead of naming it. Commit a fix, or re-test once the cause is resolved — see
[Reviews](/version-control/reviews/#merge).

## Everyone is refused with "Rate limit exceeded"

```json
{"detail":"Rate limit exceeded. Please try again later."}
```

for every visitor at once, or one person's failed sign-ins lock everyone else out: every visitor is
arriving from one address and sharing one limit.

- **A five-container install upgraded with `docker compose pull`:** its stack file predates
  per-visitor limits. Re-run the installer, as [the v0.2.24 note](/operate/upgrades/) says.
- **Another proxy in front — Cloudflare, a load balancer, a Cloudflare Tunnel:** list it in
  `SARATI_TRUSTED_PROXIES`, as [Behind another proxy](/operate/configuration/#behind-another-proxy)
  shows.

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
