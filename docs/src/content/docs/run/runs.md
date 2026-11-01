---
title: Runs
description: What ran, on which version, and what each step produced.
---

**Runs** lists every execution of a workflow, newest first.

| Column | |
|---|---|
| Status | Running, Waiting, Completed, Failed or Cancelled. Over the API a failed run is `error`. |
| Source | What started it — webhook, schedule, manual, chat. |
| Environment | Which environment's pointer was used. |
| Version | The exact version that ran. |
| Started · Duration | |
| Error | The failure, when there was one. |

Every run records the version it executed, so a run from last week is still explainable after the
workflow has moved on.

<img class="shot shot-dark" src="/shots/run-detail-dark.webp" alt="A completed run expanded to show its step log and output." />
<img class="shot shot-light" src="/shots/run-detail-light.webp" alt="A completed run expanded to show its step log and output." />

## One run

Click a row for its step log: each step, its status, how long it took, and its full output. The run
id is at the bottom.

While a run is still going the list refreshes on its own and stops once everything has settled.

Link straight to a run by adding `?run=<run-id>` to the Runs URL.

## Dry runs

A [dry run](/build/testing/#the-whole-workflow) is listed with the rest, as **Dry run** rather than
Completed — it sent nothing, so it never reads as a run that did. Open it and each step it did not
carry out says what it did instead:

```
post_summary   Not sent — would call POST https://slack.com/api/chat.postMessage
pause          Wait skipped — 48h 0m
approve        Not waited for — a dry run does not pause for an event
```

Over the API the run carries `dry_run: true`, and each such step's output carries `withheld`:
`write`, `managed_step`, `delay` or `wait`.

## Durability

Runs are durable. If the engine is killed or redeployed mid-flight, the run resumes when it comes
back instead of being orphaned.

A run v0.2.25 or later started resumes where it was, parallel branches included: no step that had
finished runs again, except in a workflow it was calling, which runs again from its start if the call
had not finished. The exception is a run v0.2.24 or earlier started that resuming could leave with a
step's result or a decision in the wrong place. As it resumes it ends in `error` with a message saying
why, each ending "so it can't be resumed safely — run it again.":

- **"This run had already run steps side by side when it stopped…"** — it had run steps in parallel
  branches, or steps that start at the same time, even if they had all finished.
- **"This run's AI Agent step was refused a sub-workflow call before it stopped…"** — the step asked
  to call a workflow once the run had made 64 such calls, some of them inside the workflows it
  called, and carried on without it. Resuming would not count those again, so it could make the call
  it was refused.
- **"This run's history can't be matched to its workflow…"** — what it recorded does not fit its
  workflow, so there is no telling whether resuming it is safe.

None of its steps runs again, its waits leave the inbox, and a decision it had not taken yet is
recorded on its wait, with who made it, but not applied. Each step it had under way ends in `error`
saying *Stopped when the service did — the run can't be resumed safely*, and none of them is named
as the step that failed. Run the workflow again. A run that stopped before any of this resumes as
usual; [Upgrades](/operate/upgrades/#upgrade) says how to list the runs v0.2.24 or earlier started
that would end this way.

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

Idempotent — cancelling an already-finished run is not an error, and answers with the status it
finished in.

The run is listed as **Cancelled** at once and stops at its next step. A step already making its
call finishes, because a request that has gone out can't be taken back, and that includes the HTTP
client retrying that one request. The step's own retry setting makes no further attempt, and nothing
after it starts. A caller still waiting on the run's answer gets `409` with the code
`run_cancelled`.

Every wait or delay the run is parked on ends and says *Cancelled before it finished*, and a
decision someone sent that the run had not yet taken is dropped. One the run had already taken
stands, and its wait records who made it. On a durable run
(the default) that can take up to about ten seconds, so a delay with less than that left simply runs
out. A run v0.2.24 or earlier started is slower to stop: there a delay of a minute or less runs out
first.
On a run that isn't durable (`DBOS_ENABLED=false`, or a dry run) it ends at once, and so does a
workflow the run is calling; a durable run's called workflow finishes first.

If the engine can't be told of a durable run's cancel, the cancel answers `500` and changes nothing,
so it is safe to try again.

A run that another run's step started can't be cancelled on its own (`409`, code `called_run`).
Cancel the run that called it.

## When a worker dies

Durable resume covers a worker that comes back. A worker that does not come back would otherwise
leave runs stuck `running` forever, so a reaper sweeps at boot and every five minutes, and moves to a
terminal `error`:

- a run in flight for longer than `RUN_MAX_DURATION_SECONDS` since it started or last resumed from a
  wait. Time a run spends parked — on an approval, or on a **Wait** longer than a minute — never
  counts. A shorter **Wait** sleeps in flight and does count, and so does a **Wait** inside a called
  sub-workflow, against the run that called it;
- a run whose approval window has passed, or whose **Wait** step is past its wake by that long, with
  no decision on its way to it;
- a run holding a decision whose wait is past its window by `RUN_MAX_DURATION_SECONDS`, when this
  instance can no longer resume it to take the decision. Its error names who decided, and the wait
  they decided records them.

A run with a decision on its way that can still resume is left to take it. Set
`RUN_MAX_DURATION_SECONDS=0` to turn the reaper off.

## Nothing here yet

An empty list means nothing has fired. Check that a version is live in the environment you are
firing at — a webhook URL for an environment with nothing live answers `404 Webhook not found`.
