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
| `COMPOSE_PROJECT_NAME` | This install's name. `docker compose` in this directory acts on it, and its volumes are named after it, so changing it points at a different, empty install. |
| `SARATI_STACK` | `single` or `compose`: the shape the install was built with, which the installer keeps. |
| `SARATI_URL` | The one origin everything is reached through. |
| `SARATI_PORT` | Host port for the proxy, 1 to 65535, optionally after an IP address to listen on, like `127.0.0.1:8080`. Default `8080`. |
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

# How long a run nothing on this instance holds may stay in flight since it started or last resumed
# from a wait before it is declared dead. 0 turns that off; a run past RUN_MAX_ACTIVE_SECONDS is
# still stopped.
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

## Run limits

Every run runs within limits, so one workflow can't run forever or take an instance over. The
defaults leave a normal install alone; lower them on an instance strangers can use. Each number
applies per workspace, `0` turns that limit off, and none may be more than `2147483647`. Every
organization is a workspace with numbers of its own, and anyone signed in can create organizations,
so the workspace limits bound what runs at once in one workspace, not what one person runs.

| Variable | Default | What it limits |
|---|---|---|
| `RUN_MAX_STEPS` | `250000` | Steps one run may take: every action, Code step, AI Agent model or tool call and sub-workflow call, the steps of every workflow it calls included. |
| `RUN_MAX_LOOP_ROUNDS` | `250000` | Loop rounds one run may take: a **Loop**'s items plus its while rounds, over every loop in the run. |
| `RUN_MAX_ACTIVE_SECONDS` | `86400` | Seconds a run may stay in flight, counted from its start, the last time it came back from waiting, or the service's last start, whichever is latest — so a restart, like the end of a wait, starts its clock again. Time the whole run is parked — on an approval, or a long **Wait**, a **Wait** in a workflow it calls included — never counts, and nor does time the service is down. A branch parked beside a busy one doesn't stop the clock. |
| `WORKSPACE_MAX_RUNNING_RUNS` | `1000` | Runs one workspace may have running at once. A run with a branch busy beside a parked one is running. |
| `WORKSPACE_MAX_UNFINISHED_RUNS` | `10000` | Runs one workspace may have running or waiting — on an approval or a timer — at once. |

- **A run past one of its limits ends** in `error`, reading *Run limit reached:* and naming the limit
  and the variable that raises it. The step that would have crossed it does nothing, and no error
  output or *Continue* absorbs it. A run takes the limits in force when it started, and keeps them
  through a restart. A workflow another run calls counts toward that run's steps and time, so its
  history names the run that called it.
- **A run past its time** is ended at its next step, or by the reaper within five minutes when a step
  is still in flight. The step in flight finishes, because a request that has gone out can't be taken
  back; nothing after it starts.
- **A run the workspace has no room for** is refused before anything is recorded: the caller gets
  `429` with a `Retry-After` header, a webhook is answered `429`, and a schedule or polling trigger
  keeps its place and takes the event on its next poll. A Composio event several workspaces' triggers
  share still runs in every workspace with room; the one without shows why on its trigger and runs
  when Composio sends the event again. A branch test needs room for both of its runs, or runs
  neither, and a live run over MCP that is refused costs none of the caller's hourly live runs. A run
  another run calls is never counted or refused.
- **A run that can't survive a restart** — a dry run, a run that ran while `DBOS_ENABLED=false`, a
  run whose start was not yet saved to DBOS, or any run when the service starts again with DBOS off —
  and was going when the service stopped is ended as it starts again, so it holds no place in its
  workspace.

For an instance open to anyone, something like this — and, since every person can make workspaces
that each get these numbers, gate sign-up too ([`OIDC_ALLOWED_DOMAINS`](#single-sign-on) or invites):

```bash
RUN_MAX_STEPS=1000
RUN_MAX_LOOP_ROUNDS=1000
RUN_MAX_ACTIVE_SECONDS=600
WORKSPACE_MAX_RUNNING_RUNS=3
WORKSPACE_MAX_UNFINISHED_RUNS=20
RUN_MAX_DURATION_SECONDS=900
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
through the tunnel and read `client_ip` on the newest `handled request` line of the proxy's log: while
`SARATI_TRUSTED_PROXIES` is empty, that is the address that connected. The log is `cd sarati && docker
compose logs proxy` for five containers, and `cd sarati && docker compose logs sarati` for one, where
lines from `127.0.0.1` are the container checking its own health. Once the address is listed, the same
line shows each visitor's own address.

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
organization** and are set in **Settings → Platform keys** in the running app, where each takes effect
immediately — no restart, no redeploy. The one exception is an instance that gives everyone
[its own Composio account](#one-composio-account-for-the-whole-instance).

Working inside an organization, you use that organization's keys and its owners and admins set them.
Working outside one, you use your own. They are encrypted at rest with `FERNET_KEY`, like every stored
credential, and the API never reads any of them back.

Setting `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET` or `ANTHROPIC_API_KEY` in `.env` does nothing.
If you are upgrading and had them there, enter them once in Settings and delete the lines.

## One Composio account for the whole instance

An instance anyone can try — a public demo, a classroom — can connect everyone's apps through **one
Composio account of its own**, so nobody needs a Composio key. Each person still adds their own
Anthropic key in Settings if they want the AI composer.

```bash
# Both or neither — the service stops at boot naming the one missing, and the limit below needs both.
INSTANCE_COMPOSIO_API_KEY=ak_…
INSTANCE_COMPOSIO_WEBHOOK_SECRET=whsec_…
# App actions each person may run on it per UTC calendar month. Default 500; 0 runs none.
INSTANCE_COMPOSIO_MONTHLY_ACTIONS_PER_PERSON=500
```

With them set:

- **Every connection, step and trigger uses this account.** Settings shows *Managed connections
  (Composio) · Provided by this instance* with nothing to enter, and nobody — owner, admin or member —
  can set or remove a Composio key there or through the API (`409`). Keys people stored earlier are
  kept but unused, and come back if you unset the variables.
- **Each person has a monthly allowance of app actions,** so one person cannot use up the account for
  everyone. Every request the account sends to an app counts once, charged before it is sent to the
  person whose connected account it runs as — a step, a test, an AI Agent's tool call, an account
  check on connect, a dropdown in the step inspector, each page of a listing and each retry. A step
  that runs as an [environment's slot](/run/environments/) is charged to the slot account's owner.
  An [API key](/agents/api-keys/#scopes) spends it outside a run only if it has `connection:write`.
  Settings shows each person their count and when it resets: midnight UTC on the first of the month.
  Past the limit a step fails naming the limit and the reset date
  ([the message](/operate/troubleshooting/#a-step-says-the-monthly-limit-of-app-actions-is-used-up));
  nothing is sent. `0` turns app actions off while connecting still works. For no limit, leave the
  variables unset instead — then each person or organization uses its own key.
- **Trigger events are counted, not limited.** Each delivered trigger event is counted for the
  account's owner and shown in Settings, but none is held back.
- **Gmail's new-mail trigger is Composio's *New Gmail Message Received Trigger***
  (`gmail.gmail_new_gmail_message`). Composio watches the inbox itself, and each mail it delivers is
  one trigger event. Sarati's own *New Email* trigger (`gmail.gmail_new_email_received`) is not
  offered: it asks Gmail with an app action on every poll (once a minute by default,
  `TRIGGER_POLL_INTERVAL_SECONDS`) whether or not mail arrived — 1,440 a day, which would use up the
  default limit in about eight hours. In a workflow that already has it, the trigger never checks, and
  its status names the one to use instead.

Set it up once:

1. Use a **Composio project of its own**. Composio sends a project's trigger deliveries to one URL, so
   another install on the same project stops receiving its own, and every connected account, Sarati
   user id and tool call shows in that project's dashboard — say so in the instance's terms.
2. In that project's webhook settings, send deliveries to `<PUBLIC_BASE_URL>/api/hooks/composio`, and
   copy its signing secret into `INSTANCE_COMPOSIO_WEBHOOK_SECRET`. Keep both values only in the
   instance's environment: anyone holding the secret can sign a delivery for every person.
3. Size the limit against the plan. On Composio's free plan, apps signed in through Composio's own
   OAuth apps — how Sarati connects them — share a smaller part of the monthly tool calls and trigger
   events, requests through its proxy (most of Sarati's own actions use it) the smallest part, and the
   plan pauses at its limit for everyone until the month turns. Check
   [Composio's pricing](https://composio.dev/pricing) and your dashboard's usage page, then set the
   limit so that the people you expect, times the limit, fits — or gate sign-up
   ([`OIDC_ALLOWED_DOMAINS`](#single-sign-on) or invites), since every account gets its own allowance.

Changing `INSTANCE_COMPOSIO_API_KEY` to another project, or turning it on for an install whose people
already connected apps with their own keys, leaves those connections in the other project: each person
connects their apps again. Turning it off does the same the other way: the connections made through
the instance's account stay in its project, so each person connects those apps again with their own
key.

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

On an instance that already has password accounts, add `LOCAL_AUTH_ENABLED=true` as well and
follow [Moving an instance over](/operate/users/#single-sign-on) — otherwise passwords turn off
before anyone has connected. Then put the three values the provider gives you in `.env` and run
`docker compose up -d`:

```bash
# The issuer exactly as the provider's tokens carry it — trailing slash included, or not.
OIDC_ISSUER=https://login.example.com
OIDC_CLIENT_ID=sarati
OIDC_CLIENT_SECRET=
# The email domains people may sign in from, comma-separated. Empty admits any.
OIDC_ALLOWED_DOMAINS=example.com
```

The sign-in screen then leads with **Continue with single sign-on**. Who that admits, and how
people already on the instance move over, is in [Users](/operate/users/#single-sign-on).

- **A provider anyone can join needs `OIDC_ALLOWED_DOMAINS`:** with `accounts.google.com`, Apple,
  GitLab.com or personal Microsoft accounts, anyone with an account there can otherwise make one
  here. In production the boot log warns while it is unset. Set it, too, for a provider that lets
  people set an address it has not verified — [Users](/operate/users/#single-sign-on) says why.
- **The three go together:** setting `OIDC_CLIENT_ID` or `OIDC_CLIENT_SECRET` without the other two
  stops the service at boot and names what is missing. `OIDC_ISSUER` alone does nothing, and the
  boot log says so.
- **The issuer has to match exactly:** Sarati reads `<OIDC_ISSUER>/.well-known/openid-configuration`
  and refuses a document whose `issuer` differs by so much as a trailing slash. Every endpoint comes
  from that document, so there is nothing else to set.
- **What the provider has to offer:** the `openid`, `email` and `profile` scopes, PKCE with `S256`,
  and ID tokens signed with RS256, PS256 or ES256. Sarati authenticates with the client secret as
  HTTP Basic, or in the request body when that is all the provider accepts. A new account needs an
  email address, from the ID token or from the provider's UserInfo endpoint. Invites and
  `OIDC_ALLOWED_DOMAINS` need the `email_verified` claim, which Microsoft Entra ID does not send.
  Connecting an existing account needs `max_age`, answered with `auth_time` in the ID token.
- **Changing `OIDC_ISSUER` later** connects nobody: accounts are connected per issuer —
  [Users](/operate/users/#changing-oidc_issuer) says how to carry them over.
- **`SARATI_URL` is the address people use:** the redirect URI is built from it, and a sign-in
  started at any other address cannot finish. In production, `SARATI_URL` and `OIDC_ISSUER` must be
  `https://`, or `http://` to this machine; anything else stops the service at boot.
- **A provider behind a private certificate authority:** mount the authority's certificate into the
  container and point `NODE_EXTRA_CA_CERTS` at it — see below.
- **Clerk or your own provider, not both:** `CLERK_ISSUER` with `OIDC_CLIENT_ID` stops the service
  at boot.
- **Email and password turns off:** once the three are set, `LOCAL_AUTH_ENABLED` defaults to off,
  and a password session already issued stops working. Set `LOCAL_AUTH_ENABLED=true` to keep
  passwords beside single sign-on while people move over, or as a way in while the provider is down.
  In production the boot log then warns that passwords skip the provider's MFA and offboarding.
- **The composer:** the AI composer accepts single sign-on sessions once it sees `OIDC_ISSUER` and
  `OIDC_CLIENT_ID` too. Both stacks hand it the same `.env`, so there is nothing to do.

#### A provider behind a private certificate authority

Save the authority's certificate as `ca.pem` in the install directory, beside
`docker-compose.yaml`, and add a `docker-compose.override.yaml` there. Compose reads it with the
main file, and an upgrade leaves it alone:

```yaml
services:
  sarati:
    volumes:
      - ./ca.pem:/etc/sarati/ca.pem:ro
```

On a five-container install the service is `service` instead of `sarati`. Then add
`NODE_EXTRA_CA_CERTS=/etc/sarati/ca.pem` to `.env` and run `docker compose up -d`. Until then, the
service log says `unable to verify the first certificate`.

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

- **`DBOS_ENABLED` defaults to `true`** and `DBOS_APP_VERSION` to `orchestr-1`, so
  [durable resume](/run/runs/#durability) is on without configuring anything. Never change
  `DBOS_APP_VERSION`: DBOS resumes only the runs recorded under the value it starts with.
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
