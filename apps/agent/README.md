# apps/agent — the AI composer

A slim NestJS service that runs Claude Agent SDK sessions whose only tools are thin HTTP wrappers
over `apps/service`, streaming graph operations onto the editor canvas live. It is **optional**: the
editor is fully usable without it.

## The stream

`POST /api/composer/stream` accepts `{ message, session_id?, workflow_id?, ir? }` and answers with
SSE. Every frame carries its per-session sequence number as the SSE `id:` line — the replay key for
`POST /api/composer/attach`.

| event               | payload                                                | meaning                                  |
| ------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `session`           | `{ session_id }`                                       | pass it back to continue the conversation |
| `user_message`      | `{ text }`                                             | attach replay only — the user's own message in the durable transcript (never sent live; the sender renders its own optimistically) |
| `assistant_text`    | `{ text }`                                             | streaming narration (token deltas)        |
| `brief`             | `{ goal, trigger, steps[], needs[] }`                  | the plan card — re-emits REPLACE the card |
| `question`          | `{ question_id, question, options[], node_id? }`       | the turn is PAUSED — answer via `POST /api/composer/answer` |
| `question_resolved` | `{ question_id, answer, timed_out? }`                  | resolve the chip on every surface         |
| `assumption`        | `{ node_id, text }`                                    | amber badge on that canvas node           |
| `connection_needed` | `{ node_id, provider, provider_label }`                | Connect chip on that step — cleared by a green re-test |
| `offer`             | `{ offer_id }`                                         | the save chips ("Save and turn on" / "Save as a draft" / "Keep tweaking") |
| `snapshot`          | `SessionSnapshot` (attach only)                        | point-in-time state: brief, questions, assumptions, beads, draft IR |
| `step_result`       | `{ node_id, status: passed\|failed, summary? }`        | green/red bead on that step               |
| `run_result`        | `{ status: passed\|failed, run_id?, failed_node_id? }` | one line in the thread per whole-draft run |
| `op_applied`        | `{ ops, ir }`                                          | a batch landed — render `ir` on the canvas |
| `done`              | `{ session_id, duration_ms, num_turns?, total_cost_usd? }` | turn finished                         |
| `error`             | `{ message }`                                          | turn failed (stream still ends with `done`) |

## The rest of the surface

`POST /api/composer/attach` `{ session_id?, workflow_id?, scratch?, last_event_seq? }` reattaches
after a page refresh, drop, or service restart (at least one of `session_id` / `workflow_id` /
`scratch: true` is required — 400 otherwise). Resolution: a live in-memory `session_id` wins
(same-tab fast path); otherwise the caller's **durable thread** — keyed `(user, workflow)` per the
verified token `sub`, or the user's ONE scratch thread when `scratch: true` (pre-save compose) — is
found-or-created, served by the live session bound to it or **rehydrated from the Postgres event
log** (requires `DATABASE_URL`; the schema ships with the service, in
`apps/service/db/migrations/007_composer_threads.sql`). With a durable thread, the FULL transcript
after `last_event_seq` is replayed from seq 1 in the exact live event shapes (including
`user_message`) — the chat panel re-renders through the same reducer path as live and survives
restarts. Memory-only (no `DATABASE_URL`): gap-free `last_event_seq` (still covered by the
1000-event ring buffer) → just the missed tail; otherwise ONE `snapshot` event with current state.
When a turn is live — including one paused on a question — the stream continues; an idle session's
response ends after the replay.

`POST /api/composer/token` `{ session_id }` refreshes the session's caller token mid-turn (Clerk
rotates roughly every minute; the client calls this while a turn streams) so long unattended turns
do not outlive their credentials.

`POST /api/composer/answer` `{ session_id, question_id, answer }` resolves a pending question —
thread chip or canvas chip, first answer wins; expired or answered questions are a 404. A question
left unanswered for **5 minutes** times out: the agent proceeds with its stated fallback and records
it as an assumption. The pause is a tool handler awaiting an in-process pending-answer registry
(chosen over the SDK's `canUseTool` defer, which gates permissions rather than carrying answers);
the SDK subprocess gets `MCP_TOOL_TIMEOUT=360000` so the blocked tool call outlives the pause.

`POST /api/composer/clear` `{ workflow_id?, scratch? }` clears the caller's durable conversation for
that workflow, or their scratch thread — one of the two is required, 400 otherwise.
`GET /api/health` is the container probe.

## Tools

Sixteen tools on an in-process MCP server, plus `fill_params` when `PARAM_MODEL` is set:

| tool | backed by |
| --- | --- |
| `search_catalog`, `get_action_schema` | `GET /api/compose/catalog` (search / full-schema lookup) |
| `read_workflow` | `GET /api/workflows/:id` (+ main-branch head) |
| `apply_ops` | `POST /api/compose/apply-ops` |
| `post_brief`, `ask_user`, `note_assumption` | server-side events only |
| `test_step` | `POST /api/runs/test-step` |
| `run_draft` | `POST /api/runs/from-ir` (agent-minted `run_id`, so the record stays readable) |
| `read_run`, `list_runs` | `GET /api/runs/:runId`, `GET /api/runs?workflow_id=` — the "why did this fail?" entry point |
| `get_samples` | the last completed run's real trigger + per-step output, for wiring `{{refs}}` |
| `connections_status` | `GET /api/connections` — read-only credential awareness before live runs |
| `offer_save` | server-side event only; the CLIENT drives the save/publish flows, so Save ≠ Live stays intact |
| `find_trigger` | catalog lookup for an app event; the trigger is then SET by re-typing the canvas trigger node through `apply_ops`, never as a separate step |
| `need_connection` | server-side event — Connect chips on the step and in the thread; a green re-test clears the standing ask |
| `fill_params` | a focused `PARAM_MODEL` completion gets ONE action's full schema + the step's intent; the reply is validated IN CODE — unknown keys rejected, required keys enforced, type sanity, one bounded retry — then applied through the same `apply_ops` path |

Hallucinated action types are rejected by the service's catalog allow-list and fed back to the agent
verbatim; failed tests come back as information the loop acts on, with a bounded two fix attempts per
step and then an honest stop.

## Availability — the self-host capability probe

The composer boots without `ANTHROPIC_API_KEY` and without `CLERK_ISSUER`, so a one-command stack
that ships it by default is still usable without an Anthropic account. It refuses to *pretend*,
though.

`GET /api/composer/status` (unauthenticated, always **200**) is the client's probe:

```json
{ "status": "ok" }
{ "status": "disabled", "reason": "anthropic_api_key_missing", "message": "…", "docs": "…" }
```

`reason` is `anthropic_api_key_missing` or `caller_auth_unconfigured` (no caller-auth path at all —
no `SECRET_KEY`, no `CLERK_ISSUER`, no `MOCK_AUTH`; unconfigured caller auth turns the feature OFF,
it never leaves it open). An install missing both is told about the Anthropic key first: it is the
documented opt-in.

While disabled, every functional endpoint (`/stream`, `/attach`, `/token`, `/answer`, `/clear`)
answers **503** with the same `reason` and `message`, *ahead of* authentication — an unconfigured
instance must not answer 401 and send operators hunting for the wrong problem.

Two deliberate choices worth keeping:

- The probe lives under `/api/composer/`, not on `/api/health`, because that is the only prefix a
  self-host reverse proxy routes to this service — `/api/health` lands on the main service and would
  answer a confident, wrong `ok`. (The container `HEALTHCHECK` still uses `/api/health` directly,
  which never goes through the proxy.)
- The probe is 200 even when disabled. A 503 here is indistinguishable from the proxy's own 503 for
  an upstream that is down — precisely the ambiguity the endpoint exists to remove.

On a self-host the auth wall is cleared by `SECRET_KEY`: sign-in there is **local email + password**,
and sharing that one value lets this service verify the resulting session. So the self-host path to a
working composer is `ANTHROPIC_API_KEY` + `SECRET_KEY`, with no Clerk account anywhere.

## Caller auth

`/api/composer/*` accepts callers over **two independent paths**:

| path              | token                            | verified with                                          | enabled when |
| ----------------- | -------------------------------- | ------------------------------------------------------ | ------------ |
| Clerk             | Clerk session JWT (RS256)        | networkless against the instance JWKS (`CLERK_ISSUER`)  | `CLERK_ISSUER` is set |
| Local session     | local sign-in JWT (HS256)        | shared `SECRET_KEY`, issuer `orchestr:local`            | `SECRET_KEY` is set and Clerk is not (override: `LOCAL_AUTH_ENABLED`) |

Each path pins **its own issuer and algorithm**, so a token minted for one can never be accepted by
the other — holding `SECRET_KEY` does not let anyone forge a Clerk caller, and vice versa. Local is
tried first: it is networkless, and on a self-host it is the only path there is. Local auth is off by
default whenever Clerk is configured, so a Clerk deployment never silently grows a second front door;
`LOCAL_AUTH_ENABLED` overrides either way.

`SECRET_KEY` must be **the same value `apps/service` uses** — its `docker/entrypoint.sh` generates
one onto the shared data volume on first run, so a compose file has to pass that same value here.
Rotating it signs everyone out of both services.

The Clerk path checks issuer + exp + optional `azp` allow-list (`CLERK_AUTHORIZED_PARTIES`); the
local path checks issuer + exp and takes `sub` as the caller identity. The verified bearer is
**forwarded to the service on every tool call**, so ops, reads and runs execute — and are attributed
— AS the person, not a service key. Both token families are accepted there too. The freshest token
wins, so a token can still expire inside a very long unattended turn: the tool call surfaces a
friendly error and the next interaction refreshes it. An expired token of either kind 401s as
`Token expired` rather than `Invalid token`, so the client can tell "re-login" from "something is
wrong". `MOCK_AUTH=true` bypasses verification for local dev (refused in production) and falls back
to the configured `ork_` key for tool calls.

## State

Draft state is **session-scoped and in-memory**: the editor sends its current canvas `ir` with every
message (so manual edits between turns win), the session carries it across tool calls, and the
editor's own draft autosave persists whatever the user keeps. No version commits.

**Conversations are durable** when `DATABASE_URL` is set: every emitted event write-throughs async to
`composer_thread_events` (per-thread ordering chain; a failed insert logs and never breaks the
stream), keyed by the ONE thread per `(user, workflow)` — plus one scratch thread per user for
pre-save compose, re-keyed to the created workflow on the accept path (an existing thread for that
key yields; the scratch history wins). The stored `sdk_session_id` resumes the SDK session after a
restart while its transcript file survives; otherwise the next turn starts a fresh SDK session and
the prompt re-seeds context. Unset `DATABASE_URL` = memory-only.

## Run it

From the repo root:

```bash
pnpm install
cp apps/agent/.env.example apps/agent/.env   # WORKFLOW_SERVICE_API_KEY + ANTHROPIC_API_KEY
                                             # both optional — without them it boots with the
                                             # composer disabled
pnpm --filter @sarati/agent start:dev        # :8010
```

Needs `apps/service` running (default `http://localhost:8001`).

Smoke test:

```bash
curl -N localhost:8010/api/composer/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"when a form comes in, post to Slack if amount > 500, else log to sheets"}'
```

## Deploy

The deployable artifact is `apps/agent/Dockerfile`, built **from the workspace root** because the
lockfile lives there:

```bash
docker build -f apps/agent/Dockerfile -t sarati/agent .
```

It runs `node dist/main.js` on Node 24 as a non-root user, with a `HEALTHCHECK` on `/api/health`. The
listen port comes from `PORT` and falls back to `8010`, so a platform that injects one works
unchanged — never hard-set it.

Required environment (**never commit secrets**; `apps/agent/.env.example` is the local template):

| Variable                   | Required            | Purpose                                                                                          |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `ENVIRONMENT`              | yes — set `production` | Enables prod posture (refuses `MOCK_AUTH`). Defaults to `development` if unset.                |
| `PORT`                     | platform-injected   | HTTP listen port. Leave unset locally to default to `8010`.                                       |
| `ANTHROPIC_API_KEY`        | yes                 | Claude Agent SDK credential. Unset boots with the composer **disabled** (503 + `/api/composer/status` says so) rather than failing — see "Availability". |
| `WORKFLOW_SERVICE_URL`     | yes                 | Base URL of `apps/service` (the tools' backend). Defaults to `http://localhost:8001`.             |
| `WORKFLOW_SERVICE_API_KEY` | recommended         | `ork_` fallback key for tool calls. In authed mode each call forwards the caller's own token; this is the `MOCK_AUTH`/no-token fallback. |
| `CLERK_ISSUER`             | Clerk deploys       | Clerk instance issuer. Callers' session JWTs are verified **networklessly against its JWKS** (RS256, iss/exp) — this is **not** `CLERK_SECRET_KEY`; this service holds no Clerk secret. Unset with no other caller-auth path boots with the composer **disabled**, never unauthenticated. |
| `SECRET_KEY`               | self-host           | The **same value `apps/service` uses** (its `docker/entrypoint.sh` generates one onto the shared data volume) — lets this service verify local email + password sessions. The self-host alternative to `CLERK_ISSUER`; rotating it signs everyone out. |
| `LOCAL_AUTH_ENABLED`       | optional            | Forces local-session auth on or off. Default: on when `CLERK_ISSUER` is unset, off when it is set. |
| `CLERK_AUTHORIZED_PARTIES` | recommended         | Comma-separated `azp` allow-list (the client origin[s]). Empty = `azp` not checked.               |
| `CORS_ORIGINS`             | yes                 | Comma-separated browser origins allowed to open composer streams. Defaults to `http://localhost:3100`. |
| `DATABASE_URL`             | optional            | Postgres for durable composer threads (the service's database). Unset = memory-only sessions.     |
| `PARAM_MODEL`              | optional            | Model for the focused param-filling sub-chain. Unset drops the `fill_params` tool entirely.       |

## Checks

`pnpm --filter @sarati/agent check` = lint + format:check + typecheck + unit tests. The repo gate is
`pnpm check` from the root — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Known boundaries

- **Side-effect gating is prompt-enforced and stays that way.** The catalog carries no effect
  metadata, so code cannot tell a read from a write — the agent's ask-before-live-test rule is the
  only gate. The two-fix bound and one-question-at-a-time ARE code-enforced.
- **Key scoping**: the service's API keys don't support scopes yet (`POST /api/api-keys` rejects a
  `scopes` array). The `ork_` key is only the `MOCK_AUTH` fallback; when scopes land it should be
  limited to `compose:apply-ops`, `compose:catalog`, `workflows:read`, `versions:read`,
  `runs:execute`, `runs:read`.
- The SDK subprocess env is a minimal allowlist (`PATH`/`HOME`/`TMPDIR` + `ANTHROPIC_API_KEY` + MCP
  timeouts) — this service's own secrets never reach it.
- One live turn per session; one live SSE consumer per session (a reattach replaces the previous
  tab). Sessions expire after 30 minutes idle; the replay buffer keeps the last 1000 events.
- Co-editing reconciliation lives client-side against the service's `POST /api/compose/merge`
  (field-level three-way, user-wins provisional, positions never conflict); collisions come back to
  the agent as "(canvas note)" messages it must raise via `ask_user`.
- A session created before its workflow exists (the composer-first new-workflow route) adopts the
  `workflow_id` from the first message that carries one, and never rebinds after that.
