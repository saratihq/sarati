---
title: Configuration
description: Every setting goes in your install's .env.
---

Settings go in the `.env` file in the `sarati` directory the installer created — one container or
five, the same file. Then:

```bash
cd sarati && docker compose up -d
```

Running it by hand without the installer, they are `-e` flags instead:

```bash
docker run -d --name sarati -p 8080:8080 -v sarati:/data -e LOG_LEVEL=debug sarati/sarati
```

Five values are owned by the install and should not be set by hand: `DATABASE_URL`, `SECRET_KEY`,
`FERNET_KEY`, `CORS_ORIGINS` and `FRONTEND_URL` — those follow `SARATI_URL` and the generated
secrets. `PUBLIC_BASE_URL` follows `SARATI_URL` as well, and is the one address you may
[set apart](#commonly-set).

## What the installer writes

A one-container install needs no generated secrets at all — the container writes its own into the
data volume, beside the database they decrypt. Only a five-container install has the three key rows
below.

| | |
|---|---|
| `SARATI_URL` | The one origin everything is reached through. |
| `SARATI_PORT` | Host port for the proxy. Default `8080`. |
| `SARATI_VERSION` | Image tag. Default `latest`. |
| `SECRET_KEY` | Signs sessions. Rotating it signs everyone out. |
| `FERNET_KEY` | Encrypts stored credentials. **Lose it and they are unrecoverable.** |
| `POSTGRES_PASSWORD` | The bundled database's password. |

## Commonly set

```bash
# The one address everything is reached through — change it when you put Sarati behind a domain.
SARATI_URL=https://sarati.example.com

# Where third parties send webhooks. It follows SARATI_URL; set it only when inbound traffic
# arrives somewhere else, such as a tunnel in front of a laptop instance.
PUBLIC_BASE_URL=https://your-tunnel.example.com

# trace | debug | info | warn | error. Empty → info.
LOG_LEVEL=

# How long a run may stay in flight before it is declared dead. 0 disables the reaper.
RUN_MAX_DURATION_SECONDS=3600

# Schedule and polling cadence. 0 disables; pg-boss will not go below 60.
TRIGGER_POLL_INTERVAL_SECONDS=60

# Global rate limit per client; route limits layer on top.
THROTTLE_LIMIT=60
THROTTLE_TTL_MS=60000

# Behind a reverse proxy that sets X-Forwarded-*.
TRUST_PROXY_HEADERS=false

MAX_REQUEST_BODY_BYTES=2097152

# The Claude model the AI composer calls — change it when your Anthropic key cannot use this one.
COMPOSER_MODEL=claude-opus-4-8
```

## Not here: the two platform API keys

Three settings are **not** environment variables — the Composio API key and its webhook signing
secret (managed connections), and the Anthropic key (the AI composer). They belong to a **user or an
organization**, not to the instance, and are set in **Settings → Platform keys** in the running app,
where each takes effect immediately — no restart, no redeploy.

Working inside an organization, you use that organization's keys and its owners and admins set them.
Working outside one, you use your own. They are encrypted at rest with `FERNET_KEY`, like every stored
credential, and the API never reads any of them back.

Setting `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET` or `ANTHROPIC_API_KEY` in `.env` does nothing.
If you are upgrading and had them there, enter them once in Settings and delete the lines.

## Integrations and auth

Single sign-on (`OIDC_*`, `CLERK_*`) and bring-your-own OAuth (`OAUTH_<PROVIDER>_CLIENT_ID` /
`_CLIENT_SECRET`) are set here too. With every auth variable empty, email and password is the way
in.

### Private addresses

```bash
# Hostnames the SSRF guard lets back in, comma-separated, matched exactly.
ORCHESTR_HTTP_ALLOWED_HOSTS=
```

A step or trigger that calls an address straight from this server refuses one that is not public:
private, loopback, link-local (cloud metadata included), carrier-grade NAT and reserved ranges, in
any spelling — `[::ffff:127.0.0.1]`, NAT64 and 6to4 addresses are judged by the IPv4 address they
carry. The address checked is the one actually connected to, so a name that resolves to a private
address is refused, every redirect is checked again, and a name that does not resolve is refused
too. That covers the HTTP and GraphQL steps, the HTTP and RSS polling triggers, and app steps given
an address, such as a Jira or Salesforce instance URL. Bring-your-own OAuth endpoints are checked
when you save them, and the token endpoint again on every token exchange.

To reach something on your own network — a self-hosted Jira, an internal API — add its hostname.
The match is exact: `127.0.0.1` lets in that spelling only, not `localhost` or `[::ffff:127.0.0.1]`.
It covers every port on that host.

The guard judges addresses, not what answers at them: a service of yours on a public address — the
server's own public IP, a cloud network's global IPv6 range — is not covered. Where that matters,
restrict outbound traffic at the network too.

## Container defaults differ from the source template

Running the Docker stack, not from a clone:

- **`DBOS_ENABLED` defaults to `true`** and `DBOS_APP_VERSION` to a stable in-code value, so
  [durable resume](/run/runs/#durability) is on without configuring anything.
- `ENVIRONMENT=production` and `PORT=8001` are baked into the image.
- If `SECRET_KEY` and `FERNET_KEY` are absent, the entrypoint generates them into
  `/data/secrets.env` on the service's data volume on first boot — so **that volume has to outlive
  the container**.

`apps/service/.env.example` in the repository is the full list, with a comment on every setting. It
carries development defaults, not these.

## Checking a setting landed

```bash
cd sarati && docker compose exec sarati printenv THROTTLE_LIMIT
```

On a five-container install the service is its own container, so it is `docker compose exec service`
instead.

Nothing back means the setting is not reaching the service — check it is in the same directory's
`.env` and that you ran `docker compose up -d` rather than restarting the container.
