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
| `topic` | The event name the run waits for, e.g. `manager_approval`. Names starting `orchestr:timer:` are reserved: a workflow or raw plan that uses one is refused before any step runs. |
| `timeout_ms` | How long to wait before giving up |

## While it waits

The run's status is `waiting`, and the waiting step shows in the run's step log. Nothing after it
has executed.

Every wait for an event appears in the **Approvals inbox** in the header, org-wide — so an
approval is not something one person has to remember. You can act on a teammate's run, not only your
own.

A run paused by a **Wait** step of more than a minute is also `waiting`, but it is not in the inbox:
it resumes when its time is up, and nothing else can wake it. The editor and **Runs** show it as
**Waiting until** its wake time, or **Was due at** it once that time has passed; a run waiting for an
event reads **Waiting for a decision**, with a link to the inbox. Over the API,
`GET /api/runs/<run-id>` and the MCP tool `orchestr_get_run` say which:

```json
{"status": "waiting", "waiting": {"kind": "timer", "until": "2026-10-12T09:30:00.000Z"}}
```

`kind` is `timer` or `event`; `until` is when a timer wakes, or when an event wait times out.

<img class="shot shot-dark" src="/shots/approvals-dark.webp" alt="The approvals inbox with one waiting run, its topic, a countdown, and approve or reject." />
<img class="shot shot-light" src="/shots/approvals-light.webp" alt="The approvals inbox with one waiting run, its topic, a countdown, and approve or reject." />

Each entry shows the workflow, the topic it is waiting on, who started it, how long it has waited
and **how long is left** before the timeout. **Custom payload…** sends an event other than approve or
reject.

## More than one wait at once

Steps on separate branches run at the same time, so a run can wait on several things at once — a
**Wait** step and an approval, or two approvals. Each wait is its own: every approval is a separate
entry in the inbox, answered on its own, and a **Wait** step still wakes on its own clock. The run
stays `waiting` until none is left. Its `waiting` names the one that matters most — an approval
before a timer, then whichever is due first — and each step in the run's `steps` carries its own
`waiting` while it is parked.

Two waits in one run on the **same topic** are both listed, each with its own step. Deciding one in
the inbox answers that wait and no other.

A run that resumes after a restart or a redeploy while two or more of its waits are parked at once can
put a decision on the wrong wait; this is being fixed. Until then, let parallel approvals finish before
you restart.

## Deciding

**Approve** or **Reject** from the inbox — both resume what comes after that wait, carrying your
decision into it. Or send the event yourself:

```bash
curl -X POST http://localhost:8080/api/runs/<run-id>/events \
  -H 'Content-Type: application/json' \
  -d '{"topic":"manager_approval","step_key":"approval","payload":{"decision":"approved"}}'
```

```json
{"status":"sent"}
```

`step_key` names the wait, as the inbox lists it. Leave it out and the event answers the wait on
that topic that has waited longest.

The steps after the wait execute, and the run reads `waiting` until no other wait is left. The run
records **who** decided and **when**, and the wait drops out of the inbox.

The payload is available to later steps, so the decision itself can drive what happens next.

An event answers exactly one wait: one naming a wait that was already answered is refused with
`409`, and so is one that arrives after the run was cancelled. So is an event on a topic the run is
not waiting on, and the run keeps waiting. A topic starting `orchestr:timer:` belongs to a **Wait**
step and is always refused with the code `timer_wait`, as is any event while the run waits only on
a **Wait** step.

## If nobody decides

When `timeout_ms` passes, the wait ends rather than hanging forever. A run whose worker died while
waiting is [reaped](/run/runs/#when-a-worker-dies) rather than left in limbo.
