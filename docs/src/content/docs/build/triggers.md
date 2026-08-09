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

`"fired": 0` is a real answer, not an error — it means nothing matched: a duplicate delivery, a
handshake, or no live version in that environment.

### Verify signatures

Turn on **Verify signatures** in the trigger to reject requests that are not signed by the sender
you expect. Do this before pointing a real service at the URL — without it, anyone who learns the
URL can start runs.

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
