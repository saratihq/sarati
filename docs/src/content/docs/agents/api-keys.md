---
title: API keys
description: Mint a scoped key, use it as a bearer token, revoke it.
---

API keys authenticate scripts, CI and MCP clients. They are scoped, and the scopes are enforced on
every request.

## Mint one

Settings → **API keys**, or:

```bash
curl -X POST http://localhost:8080/api/api-keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"Docs read-only","scopes":["workflow:read","run:execute"]}'
```

The plaintext key comes back **once**, prefixed `ork_`. It is never shown again — store it when you
create it or mint a new one.

## Scopes

Grant the fewest that work. The settings screen names them in plain English; the API uses the
scope strings.

| In Settings | Scope |
|---|---|
| Read workflows | `workflow:read` |
| Create and edit workflows | `workflow:write` |
| Publish, promote and merge | `workflow:deploy` |
| [Dry runs](/build/testing/#the-whole-workflow) — reads run for real | `run:dry` |
| Run for real | `run:execute` |
| Call published workflows | `workflow:invoke` |
| See connected accounts | `connection:read` |
| Manage connected accounts | `connection:write` |
| Manage your platform keys (Composio, Anthropic) | `org:manage` |

<img class="shot shot-dark" src="/shots/api-keys-dark.webp" alt="The API keys panel: name, scope checkboxes, and existing keys showing only their prefix." />
<img class="shot shot-light" src="/shots/api-keys-light.webp" alt="The API keys panel: name, scope checkboxes, and existing keys showing only their prefix." />

Testing a branch under an environment takes `workflow:deploy` as well as `run:execute` — the same
as promoting there, since it runs the branch on that environment's accounts. On Default,
`run:execute` is enough.

The list shows each key's **prefix only** — never the key itself — with its scopes and last use.

`key:manage` is deliberately **not grantable** — a key cannot mint another key. Listing keys with a
key returns `403`.

## Use it

```bash
curl -H "Authorization: Bearer ork_…" http://localhost:8080/api/workflows
```

A missing scope is refused by name, so the fix is obvious:

```json
{"detail":"This API key is missing the \"workflow:write\" scope."}
```

A key made in v0.2.27 or later is personal: it acts only in your personal workspace, the
organization it is minted for. A team organization's workflows answer `404` as if they did not
exist, even ones you can open yourself. Its organization routes refuse, and so do creating an
organization and accepting an invite into one:

```json
{"detail":"This API key is scoped to a different organization"}
```

So on such a key, `org:manage` changes only your own keys under **Settings → Platform keys**.

A key made earlier is pinned the same way unless your account had no personal workspace when it was
made. One that is not pinned reaches every workspace you belong to, and with `org:manage` it can
create and join organizations and manage each team organization you are in as far as your role there
allows: rename or delete it, and change its platform keys, members and invites. The list does not
show which keys are pinned, so revoke a key made earlier and make a new one to be sure.

## Revoke

```bash
curl -X DELETE http://localhost:8080/api/api-keys/<key-id>
```

Revocation is immediate. The list shows each key's prefix, scopes and last use, so an unused key is
easy to spot.
