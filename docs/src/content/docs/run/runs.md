---
title: Runs
description: What ran, on which version, and what each step produced.
---

**Runs** lists every execution of a workflow, newest first.

| Column | |
|---|---|
| Status | Completed, failed, or still going. |
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

Runs are durable. If the engine is restarted or redeployed mid-flight, a run resumes rather than
being orphaned.

A run stays on the version it started with. Promoting a new version does not move work already in
flight.

## Nothing here yet

An empty list means nothing has fired. Check that a version is live in the environment you are
firing at — a webhook URL for an environment with no live version accepts the request and reports
`"fired": 0`.
