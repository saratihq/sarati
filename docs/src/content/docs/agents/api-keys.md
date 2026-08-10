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
| Preview runs — changes nothing outside | `run:dry` |
| Run for real | `run:execute` |
| Call published workflows | `workflow:invoke` |
| See connected accounts | `connection:read` |
| Manage connected accounts | `connection:write` |
| Manage the organization | `org:manage` |

<img class="shot shot-dark" src="/shots/api-keys-dark.webp" alt="The API keys panel: name, scope checkboxes, and existing keys showing only their prefix." />
<img class="shot shot-light" src="/shots/api-keys-light.webp" alt="The API keys panel: name, scope checkboxes, and existing keys showing only their prefix." />

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

## Revoke

```bash
curl -X DELETE http://localhost:8080/api/api-keys/<key-id>
```

Revocation is immediate. The list shows each key's prefix, scopes and last use, so an unused key is
easy to spot.
