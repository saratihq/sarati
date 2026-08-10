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
| Callable by an agent | An AI agent calls it as a tool. |

Beyond these, the same picker searches 35+ app triggers — Slack, GitHub and others — which fire on
events in a connected account.

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

The response is an acknowledgement, not the workflow's output. `202` means the run started. To see
what it produced, open [Runs](/run/runs/).

Two answers that are not `202`:

| | |
|---|---|
| `404 Webhook not found` | No version carrying this trigger is live in that environment — or the id is wrong. |
| `202` with `"fired": 0` | Accepted, but nothing ran: a duplicate delivery, or a handshake. Not an error. |

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

Comparison is constant-time, and an empty raw body fails closed rather than being signed over a
re-serialized copy.

### Sample event

**Send a test event — I'll catch it** waits for one real request and keeps the payload as a sample,
so later steps can pick real field names instead of guessing. No sender handy? Paste a sample
event instead.

Catching a sample does not run the workflow.

## Localhost and inbound triggers

A webhook is a push. A service on the internet cannot reach `http://localhost`.

For local development, expose your instance with a tunnel and set `PUBLIC_BASE_URL` to the public
URL so generated webhook URLs are the ones a sender can actually reach.

Your own `curl` on the same machine works without any of this.
