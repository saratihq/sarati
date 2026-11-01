---
title: Triggers
description: The five ways a workflow starts, and how to get a webhook URL.
---

A workflow has exactly one trigger. Click the **Trigger** step, then **Change**.

| Trigger | Starts the workflow when |
|---|---|
| Manual | You click Run. |
| Incoming webhook | A request arrives at its URL. |
| Schedule | A timer fires. |
| Chat | A chat message arrives. |
| Called by another workflow | Another workflow's step, or an AI agent, runs it and uses its result. |

Beyond these, the same picker searches app triggers — Slack, GitHub and others — which fire on
events in an app. One that signs in listens as the account each environment assigns for its app
([how](/run/environments/#triggers-listen-as-the-environments-account)); an RSS or HTTP feed signs
in to nothing. The count depends on your
instance: the built-in actions bring a few dozen, and configuring
[managed connections](/build/connections/) takes it into the hundreds.

<img class="shot shot-dark" src="/shots/trigger-picker-dark.webp" alt="The trigger picker listing manual, incoming webhook, schedule, chat and callable-by-an-agent." />
<img class="shot shot-light" src="/shots/trigger-picker-light.webp" alt="The trigger picker listing manual, incoming webhook, schedule, chat and callable-by-an-agent." />

## Incoming webhook

Save the workflow first. The URL does not exist until there is a version to point at.

```
http://<your-host>/api/hooks/<workflow-id>/production
```

The URL is **stable forever** and belongs to one environment. Each environment gets its own, so
staging and production never share a URL.

It starts working once a version carrying this trigger is live in that environment.

```bash
curl -X POST http://localhost:8080/api/hooks/<workflow-id>/production \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
```

```json
{"status":"accepted","fired":1,"run_id":"13000cf9-…","run_ids":["13000cf9-…"]}
```

The response is an acknowledgement, not the workflow's output. `202` is sent once the run is
recorded and started durably, so a restart after it does not lose the run. To see what it produced,
open [Runs](/run/runs/).

Other answers:

| | |
|---|---|
| `404 Webhook not found` | No version carrying this trigger is live in that environment — or the id is wrong. |
| `202` with `"fired": 0` | Accepted, but nothing ran: a duplicate delivery, or a handshake. Not an error. |
| `415` | Sarati can't read the body: its `Content-Type`, `charset` or `Content-Encoding` is not one of those below. Nothing ran. See [A webhook returns 415](/operate/troubleshooting/#a-webhook-returns-415). |
| `400 The request body is not valid JSON` | Sent as JSON, but it does not parse. Nothing ran. |
| `422 Workflow can't run: …` | The version live in that environment can't run. Nothing ran. |
| `500` | Sarati could not start the run, for example because its database was unreachable. Send the delivery again: it is not treated as a duplicate, and nothing it already started runs twice. |

### What the run receives

`{{trigger.body}}` is the whole body, decoded by its `Content-Type`:

| Content-Type | `{{trigger.body}}` |
|---|---|
| `application/json`, or any `+json` type | The parsed JSON: an object, array, string, number, boolean or `null`. |
| `application/x-www-form-urlencoded` | An object of the fields. A field sent more than once is a list of its values. |
| `text/*`, `application/xml`, or any `+xml` type | The text. |
| None | The text, which must be UTF-8. |

JSON, form fields and text are read in the declared `charset`, UTF-8 if none. A body sent
compressed with `gzip`, `deflate` or `br` is read once it is decompressed.

An object's fields are also at `{{trigger.<field>}}`. A request with no body still starts a run, with
nothing in `{{trigger.body}}`.

A GitHub delivery is its event whichever **Content type** the GitHub webhook is set to: sent as form
fields, the event GitHub puts in the field `payload` arrives as `{{trigger.body}}`, just as it does
sent as JSON.

### Verify signatures

Turn on **Verify signatures** in the trigger to reject requests that are not signed by the sender
you expect. Do this before pointing a real service at the URL — without it, anyone who learns the
URL can start runs.

Presets cover the common senders (GitHub's `x-hub-signature-256`, Shopify's base64
`x-shopify-hmac-sha256`, Stripe). The generic scheme lets you name the header, algorithm, encoding
and prefix yourself; it defaults to `x-signature`, HMAC-SHA256, hex.

The signing secret is set through its own endpoint, per environment, so it never enters a workflow
version or a diff:

```bash
curl -X PUT http://localhost:8080/api/workflows/<id>/webhook-secret \
  -H 'Content-Type: application/json' \
  -d '{"node_id":"trigger","secret":"whsec_…","environment":"production"}'
```

Reading it back tells you only whether one exists — `{"secret_present":true}`.

Signing a delivery is an HMAC over the **exact bytes** you send:

```bash
BODY='{"event":"invoice.paid"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')
curl -X POST "$URL" -H "x-signature: $SIG" -H 'Content-Type: application/json' -d "$BODY"
```

| Delivery | Result |
|---|---|
| No signature header | `401 Invalid webhook signature` |
| Wrong signature | `401 Invalid webhook signature` |
| Correct signature | `202` and the run starts |

The signature is checked over the body's bytes as they were sent, once any `Content-Encoding` is
undone, whatever their content type: an empty body over no bytes, never over a re-serialized copy.
The comparison is constant-time.

### Sample event

**Send a test event — I'll catch it** waits for one real request and keeps it as a sample, so later
steps can pick real field names instead of guessing. The sample is the trigger as a run would see
it: the body at `body`, and an object's fields beside it. No sender handy? Paste a sample event
instead.

Catching a sample does not run the workflow.

## Schedules and polled app triggers

A schedule, or an app trigger that checks a feed, moves on (past the time it fired, or past the items
it found) only once each run it starts is recorded and started. A check that fails part of the way is
made again, and a run it had already started does not run twice. The items one check finds each start
their own run, and those runs go on side by side.

## Changing a live app trigger

An app trigger that is live in an environment is registered with the app — a webhook in GitHub or
Stripe, a subscription, or a place in a polled feed. Promoting a version that changes the trigger's
type or its settings, or giving the environment's slot a different account, replaces that
registration:

1. The old one is deleted, with the account and settings that created it.
2. The new one starts fresh from that moment; it never picks up where the old one was.

Until the new one is in place, an old polled trigger is not checked, so nothing it finds starts the
version you promoted.

A version whose trigger the environment's account can't serve is refused when you promote it, so
nothing is replaced. If the account stops being active after the promote, before the trigger is
replaced, what is live stays at the app but starts no run, and the change waits until the account is
active again. If the new trigger is for another app, the old one is taken down all the same, and the
new one waits for its account; see
[Triggers listen as the environment's account](/run/environments/#triggers-listen-as-the-environments-account).

A promote that changes only other steps, or where the trigger sits on the canvas, replaces nothing:
a polled trigger carries on from where it was.

Renaming the environment replaces a webhook the same way, because the address the app calls carries
the environment's name: the webhook at the old address is deleted and one is registered at the new
one. While the account the webhook was registered with isn't active, neither can be done, so the
rename is refused; see [Rename and delete](/run/environments/#rename-and-delete).

If the app can't delete the old webhook, or doesn't answer within ten seconds, the new trigger goes
live anyway, and the delete is tried again every fifteen minutes — even after you remove the trigger,
its workflow or its environment. No delete is sent with an account that isn't active: it waits until
the account that registered the webhook is active again. An app that allows one webhook per address,
such as GitHub, gets that delete first when a trigger is registered again at the same address. While
the old webhook's account isn't active, that delete is made with the account registering the new
one, if it can reach the webhook, and counts only once the app answers that it deleted it.
A webhook that a live trigger has registered again is never deleted: Typeform keeps one webhook per
form for each workflow environment, and a new trigger on that form takes it over. A webhook that no
live trigger holds is given up when the account that created it has been removed, or when the app
rejects its credential (a rate limit is not a rejection): the service log then names the webhook
and the repository or form it is on (at warn level), and you delete it in the app yourself.

Linear is the exception: the Linear trigger does not report a failed delete, so a webhook it could
not delete stays in Linear and nothing retries it. The service log names every Linear webhook it
deletes, with its address (at warn level), so one still in Linear can be found and deleted there.

A registration that failed to start shows its error on the workflow overview, which reads **Not
listening**, and is retried every fifteen minutes, and when the service starts. Until it has
started, the trigger fires nothing: a polled trigger whose feed could not be read when it started is
not checked, so it never fires the items that were already in its feed.

## Localhost and inbound triggers

A webhook is a push. A service on the internet cannot reach `http://localhost`.

For local development, expose your instance with a tunnel and set `PUBLIC_BASE_URL` to the public
URL so generated webhook URLs are the ones a sender can actually reach.

If the tunnel's address changes, update `PUBLIC_BASE_URL` and restart. Webhooks registered with apps
move to the new address when the service starts, except one whose account isn't active: it moves once
the account is active again. A URL you gave a sender yourself has to be updated there.

Your own `curl` on the same machine works without any of this.
