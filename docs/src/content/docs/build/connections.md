---
title: Connections
description: Give a step an account — one-click, or your own key.
---

Many steps need no account at all. The catalog says which: **No account needed** or **One-click
managed sign-in available**.

When a step does need one, the workflow never holds the credential. It names the app; the
[environment](/run/environments/) supplies the account.

Connected accounts and the environments that use them live under **Integrations**:

<img class="shot shot-dark" src="/shots/integrations-dark.webp" alt="The integrations screen listing connected accounts and per-environment assignments." />
<img class="shot shot-light" src="/shots/integrations-light.webp" alt="The integrations screen listing connected accounts and per-environment assignments." />

## One-click sign-in

With a Composio key on the instance, the catalog offers managed sign-in for a large set of apps —
121 on the instance these docs were written against.

Starting a connect creates a pending connection and hands back a hosted link:

```json
{"connection_id": "e5050a29-…", "redirect_url": "https://connect.composio.dev/link/lk_…"}
```

You complete the sign-in there. The connection polls `pending` until you do, then `active`:

```json
{"id":"3207defd-…","provider":"slack","auth_type":"managed","status":"active"}
```

Set it up by adding a Composio API key in **Settings → Platform keys**. Working inside an
organization that is the organization's key, set by an owner or admin and used by every member;
working outside one it is your own. Managed connections turn on the moment it is saved. Get a key
from the [Composio dashboard](https://app.composio.dev/developers).

Without a key, managed connections are simply absent: built-in actions and bring-your-own auth work
exactly as before.

## Using one in a step

A step that needs an account names the connection. Without one it refuses up front rather than
failing mid-run:

```json
{"detail":"Step \"slack.list_channels\" requires a slack connection — attach one to this step and retry"}
```

With the connection attached, the step runs against the real account and returns real data — a
Slack `list_channels` comes back with the workspace's actual channels.

## The AI Agent step needs one too

An **AI Agent** step calls a model, and that model call is a connection like any other: connect
Claude (or OpenAI, Gemini, Mistral) under **Integrations → Use your own credentials**, then pick the
account on the step's model. An [environment](/run/environments/) run resolves it from that
environment's slot for the provider instead.

The Anthropic key in **Settings → Platform keys** is a different credential: it powers the
[AI composer](/agents/ai-composer/) — the thing that builds workflows for you — and is never used to
run a step. Setting it does not give agent steps a model, which is why an agent step can fail for a
missing Claude connection on an instance whose composer works.

## Bring your own key

For an app you already have a token for, create the connection directly:

```bash
curl -X POST http://localhost:8080/api/connections \
  -H 'Content-Type: application/json' \
  -d '{"provider":"github","credential":"…","display_name":"GitHub (my token)"}'
```

```json
{"id":"a3c48023-…","provider":"github","auth_type":"token","status":"active"}
```

## The credential never comes back

No connections endpoint returns it — not the create response, not the list, not the references, and
not the output of a step that just used it. What you get is the id, provider, display name, auth
type and status.

That holds for both kinds. A managed Slack connection runs a real action against the workspace, and
the OAuth token appears nowhere in the API surface.

Testing a connection checks that the stored secret is readable, **not** that the provider accepts
it:

```json
{"ok":true,"status":"active",
 "detail":"The API key is stored and readable; it is verified with the provider when a step runs."}
```

So a typo'd token still tests `active`. The first real check is the first real step.

## Losing the key

Credentials are encrypted with the install's `FERNET_KEY`. Lose that and they are unrecoverable —
back up your `.env`. See [Install](/start/install/#back-up-env).

## Inbound app triggers need a public URL

A webhook from a third-party app is a **push**. Nothing on the internet can reach `localhost`, so
app triggers do not fire on a laptop instance without a tunnel.

To receive them, expose the instance (`cloudflared` needs no signup) and point `PUBLIC_BASE_URL` at
the public URL — that one is the instance's address, so it stays in `.env`. Then add your **Composio
webhook secret** in **Settings → Platform keys**, beside the API key and scoped the same way, and
register the public URL in the Composio dashboard under **Settings → Webhooks**.

A delivery is verified against the secret of whichever user or organization owns the workflow it is
for. Without that secret stored, deliveries are rejected rather than run.

Polling triggers need none of this — they reach out rather than being pushed to. Your own `curl` to
a [webhook trigger](/build/triggers/) also works without a tunnel, because it is on the same
machine.
