---
title: Configuration
description: Every setting goes in your install's .env.
---

Put settings in the `.env` file next to your `docker-compose.yaml`, then:

```bash
docker compose up -d
```

Anything in that file reaches the service and the composer. Six values are owned by compose and
should not be set by hand: `DATABASE_URL`, `SECRET_KEY`, `FERNET_KEY`, `CORS_ORIGINS`,
`FRONTEND_URL` and `PUBLIC_BASE_URL` — those follow `SARATI_URL` and the installer's generated
secrets.

## What the installer writes

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
# Where webhook URLs are minted from — set this when you put Sarati behind a domain.
PUBLIC_BASE_URL=https://sarati.example.com

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
```

## Integrations and auth

```bash
# Managed connections. Empty is inert — built-in actions and bring-your-own auth still work.
COMPOSIO_API_KEY=
COMPOSIO_WEBHOOK_SECRET=

# The AI composer. Empty → it reports itself unavailable and everything else works.
ANTHROPIC_API_KEY=

# Hosts the SSRF guard lets back in. It blocks private, loopback, link-local and
# cloud-metadata targets by default.
ORCHESTR_HTTP_ALLOWED_HOSTS=
```

Single sign-on (`OIDC_*`, `CLERK_*`) and bring-your-own OAuth (`OAUTH_<PROVIDER>_CLIENT_ID` /
`_CLIENT_SECRET`) are configured the same way. With every auth variable empty, email and password is
the way in.

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
docker compose exec service printenv THROTTLE_LIMIT
```

Nothing back means the setting is not reaching the service — check it is in the same directory's
`.env` and that you ran `docker compose up -d` rather than restarting the container.
