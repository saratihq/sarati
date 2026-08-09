---
title: Approvals
description: Pause a run until a person decides.
---

A **Wait for event** step pauses the run until an event arrives on its topic, or the timeout passes.

```
Trigger → Manager approval → Record the decision
```

Configure the step with a topic and how long to wait:

| Field | |
|---|---|
| `topic` | The event name the run waits for, e.g. `manager_approval` |
| `timeout_ms` | How long to wait before giving up |

## While it waits

The run's status is `waiting`, and the waiting step shows in the run's step log. Nothing after it
has executed.

Every waiting run appears in the **Approvals inbox** in the header, org-wide — so an approval is not
something one person has to remember.

## Deciding

Approve from the inbox, or send the event:

```bash
curl -X POST http://localhost:8080/api/runs/<run-id>/events \
  -H 'Content-Type: application/json' \
  -d '{"topic":"manager_approval","payload":{"decision":"approved"}}'
```

```json
{"status":"sent"}
```

The run picks up where it stopped and the remaining steps execute. The run records **who** decided
and **when**, and it drops out of the inbox.

The payload is available to later steps, so the decision itself can drive what happens next.

## If nobody decides

When `timeout_ms` passes, the wait ends rather than hanging forever. A run whose worker died while
waiting is [reaped](/run/runs/#when-a-worker-dies) rather than left in limbo.
