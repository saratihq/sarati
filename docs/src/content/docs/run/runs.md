---
title: Runs
description: What ran, on which version, and what each step produced.
---

**Runs** lists every execution of a workflow, newest first.

| Column | |
|---|---|
| Status | `running`, `waiting`, `completed`, `error` or `cancelled`. |
| Source | What started it — webhook, schedule, manual, chat. |
| Environment | Which environment's pointer was used. |
| Version | The exact version that ran. |
| Started · Duration | |
| Error | The failure, when there was one. |

Every run records the version it executed, so a run from last week is still explainable after the
workflow has moved on.

## One run

Click a row for its step log: each step, its status, how long it took, and its full output. The run
id is at the bottom.

While a run is still going the list refreshes on its own and stops once everything has settled.

Link straight to a run by adding `?run=<run-id>` to the Runs URL.

## Durability

Runs are durable. If the engine is killed or redeployed mid-flight, the run resumes when it comes
back instead of being orphaned.

Killing the service outright during a ten-second HTTP step:

```
21:46:13  run starts, step in flight
21:46:17  docker compose kill service     ← SIGKILL, run still "running"
21:46:33  service healthy again
21:46:43  run completed
```

No intervention, no retry by hand. The run picks up and finishes.

A run stays on the version it started with. Promoting a new version does not move work already in
flight.

## When a step fails

The run ends in `error` and both the run and the failing step carry the reason:

```
run status : error
run error  : http.send_request failed: HTTP 500
step boom  : error — http.send_request failed: HTTP 500
```

**There is no "retry this run" button.** Retries are decided before the fact, not after:

- **Per step** — set *Retry on failure* attempts above 1 in the step's inspector.
- **Per step** — set *On failure* to *Continue* so one failure does not end the run.
- **Per run** — fire the trigger again. Send an `Idempotency-Key` header if a duplicate would
  matter.

## Cancelling

```bash
curl -X POST http://localhost:8080/api/runs/<run-id>/cancel
```

Idempotent — cancelling an already-finished run is not an error.

## When a worker dies

Durable resume covers a worker that comes back. A worker that does not come back would otherwise
leave runs stuck `running` forever, so a reaper sweeps every five minutes and moves anything past
`RUN_MAX_DURATION_SECONDS` to a terminal `error`.

It is purely time-based, which is what makes it safe with several replicas: nothing still alive can
be older than the maximum duration. Set `RUN_MAX_DURATION_SECONDS=0` to turn it off.

## Nothing here yet

An empty list means nothing has fired. Check that a version is live in the environment you are
firing at — a webhook URL for an environment with no live version accepts the request and reports
`"fired": 0`.
