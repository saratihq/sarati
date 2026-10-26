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

# How long a run may stay in flight since it started or last resumed from a wait before it is
# declared dead. 0 disables the reaper.
RUN_MAX_DURATION_SECONDS=3600

# Schedule and polling cadence. 0 disables; pg-boss will not go below 60.
TRIGGER_POLL_INTERVAL_SECONDS=60

# Global rate limit per client; route limits layer on top.
THROTTLE_LIMIT=60
THROTTLE_TTL_MS=60000

# Address ranges of a proxy in front of Sarati's own, space-separated — see "Behind another proxy".
SARATI_TRUSTED_PROXIES=

MAX_REQUEST_BODY_BYTES=2097152

# The Claude model the AI composer calls — change it when your Anthropic key cannot use this one.
COMPOSER_MODEL=claude-opus-4-8
```

## Behind another proxy

Rate limits count per visitor address — an IPv6 visitor per `/64`, which one subscriber is handed
whole — the sign-in limit of five attempts a minute included. Sarati's own proxy works that address
out and hands it on, so nothing needs setting when visitors reach it directly. When another proxy sits
in front — Cloudflare, a load balancer, your own nginx — every visitor arrives from that proxy's
addresses and they all share one limit, so one visitor's failed sign-ins lock everyone out. List the
proxy's addresses so each visitor's own is used:

```bash
# Cloudflare's published ranges, from https://www.cloudflare.com/ips/ — space-separated.
SARATI_TRUSTED_PROXIES=173.245.48.0/20 103.21.244.0/22 2400:cb00::/32
```

- **How the address is read:** from the right of `X-Forwarded-For`, skipping only the listed ranges,
  so a visitor cannot choose their own by sending the header. `private_ranges` stands for every
  private range, for a proxy on your own network.
- **List only proxies you run or pay for:** an address in a listed range can claim to be any visitor.
- **`CF-Connecting-IP` is never read:** anyone can send it to a server that Cloudflare does not front.

### A Cloudflare Tunnel

`cloudflared` connects to Sarati itself, so tunnel requests arrive from wherever `cloudflared` runs —
not from Cloudflare's ranges, which change nothing here. Cloudflare has already put the visitor on
`X-Forwarded-For`; list the address Sarati sees `cloudflared` connect from. To find it, send one request
through the tunnel and read `remote_ip` on its line in the proxy's log: `cd sarati && docker compose
logs proxy` for five containers, `cd sarati && docker compose logs sarati` for one.

With `cloudflared` on the same machine as Docker, that is Docker's gateway address, which every other
connection to the published port from that machine shares — and anything arriving from a listed
address can name its own. List it only where nobody else reaches that port. Leaving
`SARATI_TRUSTED_PROXIES` empty is safe: tunnel visitors then share one limit, and nobody can name an
address.

### The service and agent images without Sarati's proxy

Running the `sarati-service` and `sarati-agent` images behind a proxy of your own instead of the
bundled one, set the same two values on both:

- **`TRUST_PROXY_HOPS`:** the number of proxies in front that each append to `X-Forwarded-For`. Its
  default, `0`, uses the connecting address. Counting too few only makes visitors share a limit;
  counting too many lets any visitor write the address their limits count against, so sign-in attempts
  become unlimited. The agent sends the address it reads on to the service with every call, so the two
  must agree.
- **`LISTEN_HOST`:** the interface each listens on, on its `PORT`, the only port either opens. A trusted
  hop is believed whoever connects, so bind them where only your proxy can reach — `127.0.0.1` when it
  runs on the same machine. Unset, they listen on every interface.

The one-container image and `docker-compose.yaml` set `TRUST_PROXY_HOPS=1` for Sarati's own proxy, and
the one-container image binds both to `127.0.0.1`.

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

Sign-in (`OIDC_*` for your own identity provider, `CLERK_*` for Clerk) and operator OAuth apps
(`OAUTH_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`) are set here too. With every auth variable empty,
email and password is the way in.

### Single sign-on

People sign in through your own identity provider — any that speaks OpenID Connect. At the provider,
register Sarati as a web application with a client secret (the authorization code flow), and give it
one redirect URI:

```
<SARATI_URL>/auth/oidc/callback
```

Then put the three values it gives you in `.env` and run `docker compose up -d`:

```bash
# The issuer exactly as the provider's tokens carry it — trailing slash included, or not.
OIDC_ISSUER=https://login.example.com
OIDC_CLIENT_ID=sarati
OIDC_CLIENT_SECRET=
# Optional: the email domains an account may come from, comma-separated. Empty admits any.
OIDC_ALLOWED_DOMAINS=example.com
```

The sign-in screen then leads with **Continue with single sign-on**. Who that admits, and how
people already on the instance move over, is in [Users](/operate/users/#single-sign-on).

- **The three go together:** setting `OIDC_CLIENT_ID` or `OIDC_CLIENT_SECRET` without the other two
  stops the service at boot and names what is missing. `OIDC_ISSUER` alone does nothing, and the
  boot log says so.
- **The issuer has to match exactly:** Sarati reads `<OIDC_ISSUER>/.well-known/openid-configuration`
  and refuses a document whose `issuer` differs by so much as a trailing slash. Every endpoint comes
  from that document, so there is nothing else to set.
- **What the provider has to offer:** the `openid`, `email` and `profile` scopes, PKCE with `S256`,
  and ID tokens signed with RS256, PS256 or ES256. Sarati authenticates with the client secret as
  HTTP Basic, or in the request body when that is all the provider accepts. A new account needs an
  email address, from the ID token or from the provider's UserInfo endpoint.
- **`SARATI_URL` is the address people use:** the redirect URI is built from it, and a sign-in
  started at any other address cannot finish. In production, `SARATI_URL` and `OIDC_ISSUER` must be
  `https://`, or `http://` to this machine; anything else stops the service at boot.
- **A provider behind a private certificate authority:** point Node's `NODE_EXTRA_CA_CERTS` at the
  authority's certificate, at a path inside the container.
- **Clerk or your own provider, not both:** `CLERK_ISSUER` with `OIDC_CLIENT_ID` stops the service
  at boot.
- **Email and password turns off:** once the three are set, `LOCAL_AUTH_ENABLED` defaults to off,
  and a password session already issued stops working. Set `LOCAL_AUTH_ENABLED=true` to keep
  passwords beside single sign-on while people move over, or as a way in while the provider is down.
  In production the boot log then warns that passwords skip the provider's MFA and offboarding.
- **The composer:** the AI composer accepts single sign-on sessions once it sees `OIDC_ISSUER` and
  `OIDC_CLIENT_ID` too. Both stacks hand it the same `.env`, so there is nothing to do.

### Private addresses

```bash
# Hosts the SSRF guard lets back in: comma-separated hostnames or IP addresses, each covering every port.
ORCHESTR_HTTP_ALLOWED_HOSTS=
```

A step or trigger that calls an address straight from this server refuses one that is not public:
private, loopback, link-local (cloud metadata included), carrier-grade NAT and reserved ranges, in
any spelling. `[::ffff:127.0.0.1]`, 6to4 and NAT64 addresses (`64:ff9b::/96` and the local-use
`64:ff9b:1::/96`) are judged by the IPv4 address they carry; the rest of `64:ff9b:1::/48` is
refused, so on a DNS64 network with another local-use prefix, allowlist the hostnames you call. The
address checked is the one actually connected to, with or without a proxy, so a name that resolves
to a private address is refused, and every redirect is checked again.

- **What it covers:** every step and trigger that sends from this server, including app steps and
  triggers on your own credentials. Only the HTTP and GraphQL steps and the HTTP and RSS polling
  triggers can reach a host you name. A connection's credential only ever goes to its own app's
  domains, and no entry here changes that
  ([the refusal and what to set](/operate/troubleshooting/#a-step-wont-send-its-connections-credential)),
  so for a step or trigger with a connection an entry matters only for that app's own domains, as
  under an egress proxy or synthetic DNS below. A step on a managed connection is sent by Composio,
  not from this server.
- **Your own OAuth clients:** an OAuth client entered in the Connect dialog has its endpoints checked
  when you connect, where a host this server cannot resolve is refused too. Its token endpoint is
  checked again on every token exchange, and a token exchange never follows a redirect.
- **Letting a host in:** add its bare hostname or address. Entries are matched after URL
  normalisation: `127.0.0.1` also covers `127.1`, but not `localhost` or any IPv6 spelling, which
  need entries of their own. An entry covers every port and scheme on its host, so one written with a
  port or scheme (`localhost:11434`, `https://wiki.internal`) is ignored rather than widened, as is
  one that is not a host (a range, a wildcard, a path). Each is reported once in the log. A redirect
  target needs its own entry.
- **Who an entry is for:** everyone. Allowlisting a host lets every user on this server send any
  request to any port on it through the HTTP step and read the reply, so list only hosts you would
  expose to all members.
- **Behind an egress proxy:** set Node's `NODE_USE_ENV_PROXY=1` with `HTTP_PROXY` / `HTTPS_PROXY`
  (and `NO_PROXY`) pointing at an `http://` or `https://` proxy, and steps go through it; a SOCKS
  proxy is not supported. The target is resolved and judged on this server, and the proxy is asked
  for a tunnel to that address (`CONNECT 93.184.215.14:443`), with TLS still verified against the
  name. A proxy that filters destinations by domain name will refuse those tunnels, so list the
  domains it should see in `ORCHESTR_HTTP_ALLOWED_HOSTS`: they go to the proxy by name, unjudged,
  leaving the proxy as the only control for them. The same applies to a name this server cannot
  resolve, which is otherwise refused. `.env` reaches every process in the container, so the
  composer's calls to the service and the container's own health check would go to the proxy too:
  list the stack's own addresses in `NO_PROXY` — `localhost,127.0.0.1,::1`, plus `service` on the
  five-container stack — and any internal host you allowlisted, so it is reached directly.
- **What it cannot see:** it judges addresses, not what answers at them. A service of yours on a
  public address — the server's own public IP, a cloud network's global IPv6 range — is not covered,
  so restrict outbound traffic at the network where that matters.
- **Synthetic DNS:** if this server's DNS answers public names with private addresses — a fake-IP
  proxy such as Clash or Surge (`198.18.0.0/15`), or ZPA (`100.64.0.0/10`) — every app step on your
  own credentials is refused. Turn that mode off for this server, or allowlist the hostnames you
  call.

`COMPOSIO_BASE_URL` and `CLERK_API_URL` point the service at a proxy or a self-hosted API instead of
the provider's own. Requests to them carry an API secret, so in production each has to be
`https://`, or `http://` to the same machine (`localhost`, `127.0.0.1`, `::1`); anything else stops
the service at boot — `CLERK_API_URL` only once `CLERK_SECRET_KEY` is set. Neither may carry a
username, a password, a query string or a fragment, in any environment: the service stops at boot
and names only the address and path. Every request that carries the Composio API key — to
Composio's own API or to `COMPOSIO_BASE_URL`, from a managed step or from the service itself —
follows a redirect only while it stays on the same origin. One to any other origin fails the call
without retrying and names where it pointed, so neither the key nor the request leaves that origin
([the message](/operate/troubleshooting/#a-managed-step-says-composio-redirected-it-elsewhere)).

## Container defaults differ from the source template

Running the Docker stack, not from a clone:

- **`DBOS_ENABLED` defaults to `true`** and `DBOS_APP_VERSION` to a stable in-code value, so
  [durable resume](/run/runs/#durability) is on without configuring anything.
- `ENVIRONMENT=production` and `PORT=8001` are baked into the image.
- **`TRUST_PROXY_HOPS=1`** comes from the one-container image and from `docker-compose.yaml`: Sarati's
  own proxy is the one hop in front. The one-container image also listens on loopback only
  (`LISTEN_HOST=127.0.0.1`), so nothing but that proxy reaches the service. Leave both unset in `.env`.
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
